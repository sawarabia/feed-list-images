import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import { AtpAgent } from '@atproto/api'
import { Database } from './db'
import { DidEntry } from './config'
export class FirehoseSubscription extends FirehoseSubscriptionBase {
  private allowedDidSet: Set<string>
  private didToListUri: Map<string, string>
  constructor(
    db: Database,
    service: string,
    didEntries: DidEntry[],
    agent: AtpAgent,
  ) {
    super(db, service, didEntries, agent)

    this.allowedDidSet = new Set(didEntries.map((entry) => entry.did))
    this.didToListUri = new Map(
      didEntries.map((entry) => [entry.did, entry.listUri]),
    )
  }

  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const ops = await getOpsByType(evt)

    const postsToDelete = [...ops.posts.deletes, ...ops.reposts.deletes].map(
      (del) => del.uri,
    )
    const postsToCreate: {
      uri: string
      cid: string
      indexedAt: string
      listUri: string
    }[] = []

    // 通常ポスト（画像付きのみ）
    for (const create of ops.posts.creates) {
      if (!this.allowedDidSet.has(create.author)) continue
      const embed = (create.record as any).embed
      if (
        embed?.$type === 'app.bsky.embed.images' ||
        embed?.$type === 'app.bsky.embed.recordWithMedia'
      ) {
        const listUri = this.didToListUri.get(create.author) ?? 'unknown'
        console.log(listUri)
        postsToCreate.push({
          uri: create.uri,
          cid: create.cid,
          indexedAt: new Date().toISOString(),
          listUri,
        })
      }
    }

    // リポスト（元投稿が画像付きか確認）
    for (const create of ops.reposts.creates) {
      if (!this.allowedDidSet.has(create.author)) continue
      const subjectUri = (create.record as any)?.subject?.uri
      if (!subjectUri) {
        console.log('failed to get subjectUri')
        continue
      }

      try {
        const res = await this.agent.app.bsky.feed.getPostThread({
          uri: subjectUri,
        })

        const post = res.data.thread?.post ?? res.data.thread
        const embed = (post as any)?.record?.embed

        const hasImage =
          embed?.$type === 'app.bsky.embed.images' ||
          embed?.$type === 'app.bsky.embed.recordWithMedia'

        if (hasImage) {
          const listUri = this.didToListUri.get(create.author) ?? 'unknown'
          console.log(listUri)
          postsToCreate.push({
            uri: create.uri,
            cid: create.cid,
            indexedAt: new Date().toISOString(),
            listUri,
          })
        }
      } catch (err) {
        console.warn('⚠️ リポスト元の投稿取得に失敗:', subjectUri, err)
      }
    }

    if (postsToDelete.length > 0) {
      await this.db
        .deleteFrom('post')
        .where('uri', 'in', postsToDelete)
        .execute()
    }
    if (postsToCreate.length > 0) {
      await this.db
        .insertInto('post')
        .values(postsToCreate)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  }
}
