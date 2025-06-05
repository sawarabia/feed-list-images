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

  async run(delayMs: number = 3000) {
    await this.agent.login({
      identifier: process.env.FEEDGEN_PUBLISHER_HANDLE!,
      password: process.env.FEEDGEN_PUBLISH_APP_PASSWORD!,
    })
    console.log('Logged in')
    await this.fetchAllowedDids()
    setInterval(() => {
      this.fetchAllowedDids().catch((err) =>
        console.error('[fetchAllowedDids] periodic error:', err),
      )
    }, this.fetchInterval)
    super.run(delayMs)
  }
  // DIDリストキャッシュ
  private allowedDids = new Set<string>()
  private lastFetched = 0
  private fetchInterval = 5 * 60 * 1000
  private retryDelay = 5000 // 5秒
  private instanceId = Math.random().toString(36).substring(2, 8)

  private async fetchAllowedDids(): Promise<Set<string>> {
    const now = Date.now()
    console.log(
      `[fetchAllowedDids] Called at ${new Date(
        now,
      ).toISOString()} by instance ${this.instanceId}`,
    )

    const isInitialFetch = this.lastFetched === 0

    if (
      !isInitialFetch &&
      now - this.lastFetched < this.fetchInterval &&
      this.allowedDids.size > 0
    ) {
      console.log(
        `[fetchAllowedDids] Using cached DIDs — instance ${this.instanceId}`,
      )
      return this.allowedDids
    }

    try {
      const res = await this.agent.app.bsky.graph.getList({
        list: this.listUri,
        limit: 100,
      })

      const newSet = new Set<string>()
      res.data.items.forEach((item) => {
        newSet.add(item.subject.did)
      })

      if (newSet.size === 0 && isInitialFetch) {
        throw new Error(
          `[fetchAllowedDids] Empty list returned on initial fetch`,
        )
      }

      console.log(`[fetchAllowedDids] Retrieved ${newSet.size} DIDs:`)
      console.log('Memory usage:', process.memoryUsage())
      
      this.allowedDids = newSet
      this.lastFetched = now
      return newSet
    } catch (err: any) {
      if (err.status === 429) {
        console.warn(
          `[RateLimit] 429 received. Retrying after ${this.retryDelay / 1000}s`,
        )
        await new Promise((res) => setTimeout(res, this.retryDelay))
        return this.fetchAllowedDids()
      }

      console.error(`[fetchAllowedDids] Unexpected error`, err)

      if (isInitialFetch) {
        throw new Error(
          `[fetchAllowedDids] Failed to fetch DID list on startup`,
        )
      }

      return this.allowedDids // fallback: use stale
    }
  }

  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const allowedDids = this.allowedDids
    if (!allowedDids || allowedDids.size === 0) {
      console.warn(`[handleEvent] DID list not loaded yet or empty, skipping`)
      return
    }

    const ops = await getOpsByType(evt)
    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate = []

    const repostSubjects: {
      uri: string
      author: string
      originalUri: string
    }[] = []

    for (const create of ops.posts.creates) {
      const authorDid = create.author
      if (!allowedDids.has(authorDid)) continue

      let hasImage = false
      const record = create.record

      if (record.$type === 'app.bsky.feed.post') {
        const postRecord = record as AppBskyFeedPost.Record
        if (
          postRecord.embed &&
          postRecord.embed.$type === 'app.bsky.embed.images' &&
          Array.isArray(postRecord.embed.images) &&
          postRecord.embed.images.length > 0
        ) {
          hasImage = true
        }
      } else if (record.$type === 'app.bsky.feed.repost') {
        const repostRecord = record as unknown as AppBskyFeedRepost.Record
        const subjectUri = repostRecord.subject?.uri
        if (subjectUri) {
          repostSubjects.push({
            uri: create.uri,
            author: authorDid,
            originalUri: subjectUri,
          })
        }
        continue
      }

      if (hasImage) {
        console.log(`[MATCH] ${authorDid} - ${create.uri}`)
        // postsToCreate.push(...) など必要であれば追加
      }
    }

    // 🔁 Repost対象の元ポストを取得
    for (let i = 0; i < repostSubjects.length; i += 10) {
      const batch = repostSubjects.slice(i, i + 10)
      const uris = batch.map((item) => item.originalUri)

      try {
        const resp = await this.agent.app.bsky.feed.getPosts({ uris })
        const postMap = new Map(resp.data.posts.map((p) => [p.uri, p]))

        for (const item of batch) {
          const post = postMap.get(item.originalUri)
          const embed = post?.embed
          if (
            embed &&
            embed.$type === 'app.bsky.embed.images' &&
            Array.isArray(embed.images) &&
            embed.images.length > 0
          ) {
            console.log(`[MATCH] ${item.author} (repost) - ${item.uri}`)
            // postsToCreate.push(...) など必要であれば追加
          }
        }
      } catch (err) {
        console.error(`[getPosts] failed:`, err)
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
