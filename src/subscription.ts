import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import { AtpAgent } from '@atproto/api'
import { AppBskyFeedPost } from '@atproto/api'
import { AppBskyFeedRepost } from '@atproto/api'
import dotenv from 'dotenv'

dotenv.config()

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  private agent: AtpAgent
  private listUri: string

  constructor(db: any, endpoint: string) {
    super(db, endpoint)
    this.agent = new AtpAgent({ service: 'https://bsky.social' })
    this.listUri = process.env.FEED_LIST_URI!
  }

  // 毎回、リストからユーザーDIDを取得
  private async fetchAllowedDids(): Promise<Set<string>> {
    const allowedDids = new Set<string>()
    const res = await this.agent.app.bsky.graph.getList({
      list: this.listUri,
      limit: 200,
    })
    res.data.items.forEach((item) => {
      allowedDids.add(item.subject.did)
    })
    return allowedDids
  }

  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const allowedDids = await this.fetchAllowedDids()
    const ops = await getOpsByType(evt)

    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate = []

    for (const create of ops.posts.creates) {
      const authorDid = create.author
      if (!allowedDids.has(authorDid)) continue

      let hasImage = false
      const record = create.record as AppBskyFeedPost.Record
      // 通常投稿の画像判定
      if (
        record.embed &&
        record.embed.$type === 'app.bsky.embed.images' &&
        Array.isArray(record.embed.images) &&
        record.embed.images.length > 0
      ) {
        hasImage = true
      }
      // ↓ 前提：まだ hasImage が false のときだけ処理
      if (!hasImage && create.record.$type === 'app.bsky.feed.repost') {
        const repostRecord =
          create.record as unknown as AppBskyFeedRepost.Record
        const subjectUri = repostRecord.subject?.uri

        if (subjectUri) {
          // 元投稿を取得して embed を確認
          const originalPostResp = await this.agent.app.bsky.feed.getPosts({
            uris: [subjectUri],
          })

          const originalPost = originalPostResp.data.posts[0]
          const origEmbed = originalPost?.embed

          if (
            origEmbed &&
            origEmbed.$type === 'app.bsky.embed.images' &&
            Array.isArray(origEmbed.images) &&
            origEmbed.images.length > 0
          ) {
            hasImage = true
          }
        }
      }

      if (hasImage) {
        console.log(`[MATCH] ${create.author} - ${create.uri}`)
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

  async run(delayMs: number = 3000) {
    await this.agent.login({
      identifier: process.env.FEEDGEN_PUBLISHER_HANDLE!,
      password: process.env.FEEDGEN_PUBLISH_APP_PASSWORD!,
    })
    super.run(delayMs)
  }
}
