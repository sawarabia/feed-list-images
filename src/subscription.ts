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

    // 🔻 削除対象
    const postsToDelete: string[] = []
    const repostsToDelete: string[] = []

    for (const del of ops.posts.deletes) {
      postsToDelete.push(del.uri)
    }

    for (const del of ops.reposts.deletes) {
      repostsToDelete.push(del.uri)
    }

    // 🔻 登録対象
    const postsToCreate: {
      postUri: string
      cid: string
      indexedAt: string
      listUri: string
    }[] = []

    const repostsToCreate: {
      postUri: string
      cid: string
      indexedAt: string
      listUri: string
      repostUri: string
    }[] = []

    for (const create of ops.posts.creates) {
      if (!this.allowedDidSet.has(create.author)) continue
      const embed = (create.record as any)?.embed
      if (
        embed?.$type === 'app.bsky.embed.images' ||
        embed?.$type === 'app.bsky.embed.recordWithMedia'
      ) {
        const listUri = this.didToListUri.get(create.author) ?? 'unknown'
        postsToCreate.push({
          postUri: create.uri,
          cid: create.cid,
          indexedAt: new Date().toISOString(),
          listUri,
        })
      }
    }

    for (const create of ops.reposts.creates) {
      if (!this.allowedDidSet.has(create.author)) continue
      const subjectUri = (create.record as any)?.subject?.uri
      if (!subjectUri) {
        console.log('failed to get subjectUri')
        continue
      }

      try {
        const res = await this.agent.app.bsky.feed.getPosts({
          uris: [subjectUri],
        })
        const post = res.data.posts[0]
        const embed = (post as any)?.record?.embed

        const hasImage =
          embed?.$type === 'app.bsky.embed.images' ||
          embed?.$type === 'app.bsky.embed.recordWithMedia'

        if (hasImage) {
          const listUri = this.didToListUri.get(create.author) ?? 'unknown'
          repostsToCreate.push({
            postUri: subjectUri,
            cid: create.cid,
            indexedAt: new Date().toISOString(),
            listUri,
            repostUri: create.uri,
          })
        }
      } catch (err) {
        console.warn('⚠️ リポスト元の投稿取得に失敗:', subjectUri, err)
      }
    }

    // 🔻 削除実行
    if (postsToDelete.length > 0) {
      await this.db
        .deleteFrom('post')
        .where('postUri', 'in', postsToDelete)
        .execute()
    }

    if (repostsToDelete.length > 0) {
      await this.db
        .deleteFrom('repost')
        .where('repostUri', 'in', repostsToDelete)
        .execute()
    }

    // 🔻 登録実行
    if (postsToCreate.length > 0) {
      await this.db
        .insertInto('post')
        .values(postsToCreate)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }

    if (repostsToCreate.length > 0) {
      await this.db
        .insertInto('repost')
        .values(repostsToCreate)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  }
}
