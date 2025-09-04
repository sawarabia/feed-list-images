import { AtpAgent } from '@atproto/api'
import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import { Database } from './db'
import dotenv from 'dotenv'
import { FeedViewPost } from '@atproto/api/dist/client/types/app/bsky/feed/defs'

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
  private actors_arr: { did: string; listUri: string }[] = []
  private nextFetchTargetDateTime: string
  private lastListRefreshDate: string
  private postRetentionDays: number

  constructor(public db: Database) {
    this.agent = new AtpAgent({
      service: 'https://bsky.social',
    })
    this.postRetentionDays = Number(process.env.POST_RETENTION_DAYS ?? '30')
    if (isNaN(this.postRetentionDays) || this.postRetentionDays <= 0) {
      throw new Error('環境変数 POST_RETENTION_DAYS の値が無効です')
    }
  }

  async run() {
    await this.updateActorsIfNeeded() // ユーザー取得
    await this.reload() // 投稿取得
  }

  // 取得対象ユーザーは1日1回更新
  private async updateActorsIfNeeded() {
    const today = new Date().toISOString().slice(0, 10) // yyyy-mm-dd
    if (this.lastListRefreshDate === today && this.actors_arr.length > 0) return

    // DBをクリア
    await this.db.deleteFrom('post').execute()

    // 次回フェッチは保存期間全体が対象
    this.nextFetchTargetDateTime = new Date(
      Date.now() - this.postRetentionDays * 864e5,
    ).toISOString()

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

    const lists = process.env.FEEDGEN_LIST_URIS?.split(',')
    if (!lists) {
      throw new Error('リストが設定されていません')
    }
    const newActors: { did: string; listUri: string }[] = []

    for (const list of lists) {
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
          listUri: list,
        }))
        newActors.push(...entries)

        cursor = membersRes.data.cursor
      } while (cursor)
    }

    this.actors_arr = newActors
    this.lastListRefreshDate = today
  }

  // 投稿取得（定期実行）
  async reload() {
    await this.updateActorsIfNeeded()
    const limits = [3, 10, 30, 100]
    const fetchCountStats: Record<number, number> = Object.fromEntries(
      limits.map((limit) => [limit, 0]),
    )
    const currentfetchTargetDateTime = this.nextFetchTargetDateTime
    this.nextFetchTargetDateTime = new Date().toISOString()
    console.log(`[INFO] フェッチ開始: ${this.nextFetchTargetDateTime} (UTC)`)

    for (const actor of this.actors_arr) {
      let oldest: string | null = null
      let postsArray: FeedViewPost[] = []

      for (let limit of limits) {
        try {
          const { data: data_feed } = await this.agent.getAuthorFeed({
            actor: actor.did,
            limit,
            filter: 'posts_with_replies',
          })
          postsArray = data_feed.feed

          // 全てのポストを取得したらループを抜ける
          if (postsArray.length < limit) {
            fetchCountStats[limit]++
            break
          }
          // 取得期間より古い投稿を取得したらループを抜ける
          oldest =
            (postsArray.at(-1)?.reason?.indexedAt as string) ??
            (postsArray.at(-1)?.post.indexedAt as string)
          if (new Date(oldest) <= new Date(currentfetchTargetDateTime)) {
            fetchCountStats[limit]++
            break
          }
          // limitの上限まで取得したら終了
          if (limit === limits.at(-1)) {
            fetchCountStats[limit]++
          }
        } catch (e) {
          console.warn(`[WARN] 投稿取得失敗: ${actor.did} - ${e}`)
        }
      }

      for (const post of postsArray) {
        const uri = post.post.uri

        // 既にDBにあるポストは無視する
        const exists = await this.db
          .selectFrom('post')
          .select(['uri'])
          .where('uri', '=', uri)
          .where('listUri', '=', actor.listUri)
          .executeTakeFirst()

        if (exists) continue

        // 画像がないポストは無視する
        const embed = post.post.embed
        const hasImage = !!(
          embed?.images || embed?.$type === 'app.bsky.embed.images#views'
        )

        if (!hasImage) continue

        // indexedAtはリポスト日時が優先
        const indexedAt =
          (post.reason?.indexedAt as string) ?? post.post.indexedAt

        const postsToCreate = {
          uri,
          cid: post.post.cid,
          listUri: actor.listUri,
          indexedAt,
        }

        await this.db
          .insertInto('post')
          .values(postsToCreate)
          .onConflict((oc) => oc.doNothing())
          .execute()
      }
    }

    console.log(`[INFO] フェッチ完了: ${new Date().toISOString()} (UTC)`)
    // 統計出力
    console.log('内訳:')
    for (const limit of limits) {
      console.log(`  - ${limit}件で取得完了: ${fetchCountStats[limit]}人`)
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
