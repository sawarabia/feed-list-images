import { AtpAgent } from '@atproto/api'
import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import { Database } from './db'
import dotenv from 'dotenv'
import { FeedViewPost } from '@atproto/api/dist/client/types/app/bsky/feed/defs'
import { createHash } from 'crypto'

// リアルタイム購読（使わない）
// export class FirehoseSubscription extends FirehoseSubscriptionBase {
//   async handleEvent(evt: RepoEvent) {
//     if (!isCommit(evt)) return

//     const ops = await getOpsByType(evt)

//     // This logs the text of every post off the firehose.
//     // Just for fun :)
//     // Delete before actually using
//     for (const post of ops.posts.creates) {
//       console.log(post.record.text)
//     }

//     const postsToDelete = ops.posts.deletes.map((del) => del.uri)
//     const postsToCreate = ops.posts.creates
//       .filter((create) => {
//         // only alf-related posts
//         return create.record.text.toLowerCase().includes('alf')
//       })
//       .map((create) => {
//         // map alf-related posts to a db row
//         return {
//           uri: create.uri,
//           cid: create.cid,
//           indexedAt: new Date().toISOString(),
//         }
//       })

//     if (postsToDelete.length > 0) {
//       await this.db
//         .deleteFrom('post')
//         .where('uri', 'in', postsToDelete)
//         .execute()
//     }
//     if (postsToCreate.length > 0) {
//       await this.db
//         .insertInto('post')
//         .values(postsToCreate)
//         .onConflict((oc) => oc.doNothing())
//         .execute()
//     }
//   }
// }
dotenv.config()
export class ListMembersSubscription {
  agent: AtpAgent
  private actors_arr: { did: string; shortname: string }[] = []
  private nextFetchTargetDateTime: string
  private lastFeedRefreshDate: string

  constructor(public db: Database) {
    this.agent = new AtpAgent({
      service: 'https://bsky.social',
    })
  }

  async run() {
    await this.reload()
  }

  // 投稿取得（定期実行）
  async reload() {
    const feedRefreshed = await this.refreshFeedIfNeeded()
    const limits = feedRefreshed ? [100] : [3, 10, 30, 100]
    const fetchCountStats: Record<number, number> = Object.fromEntries(
      limits.map((limit) => [limit, 0]),
    )
    const currentFetchTargetDateTime = this.nextFetchTargetDateTime
    this.nextFetchTargetDateTime = new Date().toISOString()

    console.log(`[INFO] ポスト取得開始: ${this.nextFetchTargetDateTime} (UTC)`)

    for (const actor of this.actors_arr) {
      try {
        const { posts, usedLimit } = await this.fetchPostsForActor(
          actor,
          limits,
          currentFetchTargetDateTime,
        )
        fetchCountStats[usedLimit]++
        await this.savePosts(posts, actor)
      } catch (e) {
        console.warn(`[WARN] ポスト取得失敗: ${actor.did} - ${e}`)
      }
    }

    console.log(`[INFO] ポスト取得完了: ${new Date().toISOString()} (UTC)`)
    // 統計出力
    console.log('[INFO] 内訳:')
    for (const limit of limits) {
      console.log(
        `[INFO]   - ${limit}件で取得完了: ${fetchCountStats[limit]}人`,
      )
    }
  }

  // 日次のフィードリフレッシュ
  private async refreshFeedIfNeeded() {
    const today = new Date().toISOString().slice(0, 10) // yyyy-mm-dd
    if (this.lastFeedRefreshDate === today && this.actors_arr.length > 0) {
      console.log(
        `[INFO] リスト更新スキップ: ${new Date().toISOString()} (UTC)`,
      )
      return false
    }

    // DBをクリア
    await this.db.deleteFrom('post').execute()

    const identifier = process.env.FEEDGEN_PUBLISHER_DID || ''
    const password = process.env.FEEDGEN_PUBLISH_APP_PASSWORD || ''

    if (!identifier || !password) {
      throw new Error(
        '環境変数 IDENTIFIER または PASSWORD が設定されていません',
      )
    }

    await this.safeApiCall(() => this.agent.login({ identifier, password }))

    const did = this.agent.session?.did
    if (!did) throw new Error('ログインに失敗しました')

    let lists = process.env.FEEDGEN_LIST_URIS?.split(',')
    if (!lists) {
      try {
        const res = await this.safeApiCall(() =>
          this.agent.app.bsky.graph.getLists({
            actor: identifier,
          }),
        )
        lists = res.data.lists.map((list) => list.uri)
      } catch (e) {
        throw new Error('リストの取得に失敗しました')
      }
    }
    const newActors: { did: string; shortname: string }[] = []
    console.log(`[INFO] リスト更新開始: ${new Date().toISOString()} (UTC)`)
    for (const list of lists) {
      const shortname = createHash('sha256')
        .update(list)
        .digest('hex')
        .slice(0, 16)
      // リスト内ユーザー取得
      let cursor: string | undefined = undefined
      do {
        const membersRes = await this.safeApiCall(() =>
          this.agent.app.bsky.graph.getList({
            list: list,
            cursor,
          }),
        )

        const entries = membersRes.data.items.map((item) => ({
          did: item.subject.did,
          shortname: shortname,
        }))
        newActors.push(...entries)

        cursor = membersRes.data.cursor
      } while (cursor)
    }

    this.actors_arr = newActors
    this.lastFeedRefreshDate = today
    console.log(`[INFO] リスト更新完了: ${new Date().toISOString()} (UTC)`)
    return true
  }

  // 特定ユーザーの投稿取得
  private async fetchPostsForActor(
    actor: { did: string; shortname: string },
    limits: number[],
    targetDateTime: string,
  ): Promise<{ posts: FeedViewPost[]; usedLimit: number }> {
    let postsArray: FeedViewPost[] = []

    for (const limit of limits) {
      const { data } = await this.agent.getAuthorFeed({
        actor: actor.did,
        limit,
        filter: 'posts_with_replies',
      })

      postsArray = data.feed

      const oldest =
        (postsArray.at(-1)?.reason?.indexedAt as string) ??
        (postsArray.at(-1)?.post.indexedAt as string)

      if (
        postsArray.length < limit ||
        new Date(oldest) <= new Date(targetDateTime)
      ) {
        return { posts: postsArray, usedLimit: limit }
      }
    }
    // 取得しきれなかった場合でも最後の結果を返す
    return { posts: postsArray, usedLimit: limits.at(-1)! }
  }

  // 取得した投稿をDBに保存
  private async savePosts(
    posts: FeedViewPost[],
    actor: { did: string; shortname: string },
  ) {
    for (const post of posts) {
      // 画像ありで絞り込み
      const embed = post.post.embed
      const hasImage = !!(
        embed?.images || embed?.$type === 'app.bsky.embed.images#views'
      )

      if (!hasImage) continue

      // indexedAtはリポスト日時が優先
      const indexedAt =
        (post.reason?.indexedAt as string) ?? post.post.indexedAt

      await this.db
        .insertInto('post')
        .values({
          uri: post.post.uri,
          cid: post.post.cid,
          shortname: actor.shortname,
          indexedAt,
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  }

  // APIエラー時のリトライ処理
  private async safeApiCall<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn()
      } catch (e) {
        console.warn(`[WARN] API呼び出し失敗 (${i + 1}/${retries}) - ${e}`)
        if (i === retries - 1) throw e
        await new Promise((res) => setTimeout(res, 1000)) // 1秒待機
      }
    }
    throw new Error('API 呼び出しに失敗しました')
  }

  intervalId = setInterval(async () => {
    try {
      await this.reload()
    } catch (e) {
      console.error(`[ERROR] 投稿取得エラー: ${e}`)
    }
  }, 10 * 60 * 1000) // フェッチ間隔（ミリ秒）
}
