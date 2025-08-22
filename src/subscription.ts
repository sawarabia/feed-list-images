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
  private lastFetchDate: string | null = null

  constructor(public db: Database) {
    this.agent = new AtpAgent({
      service: 'https://bsky.social',
    })
  }

  async run() {
    await this.updateActorsIfNeeded() // ユーザー取得
    await this.reload() // 投稿取得
  }

  // 取得対象ユーザーは1日1回更新
  private async updateActorsIfNeeded() {
    const today = new Date().toISOString().slice(0, 10) // yyyy-mm-dd
    if (
      this.lastFetchDate?.slice(0, 10) === today &&
      this.actors_arr.length > 0
    )
      return

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
  }

  // 投稿取得（定期実行）
  async reload() {
    await this.updateActorsIfNeeded()

    for (const actor of this.actors_arr) {
      let oldest: string | null = null
      const limits = [3, 10, 30, 100]
      let postsArray: FeedViewPost[] = []

      for (let limit of limits) {
        // 初回フェッチは10件取得
        if (!this.lastFetchDate) limit = 10

        try {
          const { data: data_feed } = await this.agent.getAuthorFeed({
            actor: actor.did,
            limit,
            filter: 'posts_with_replies',
          })
          postsArray = data_feed.feed

          // 最も古い投稿のindexedAtを確認
          oldest =
            (postsArray.at(-1)?.reason?.indexedAt as string) ??
            (postsArray.at(-1)?.post.indexedAt as string) ??
            null

          // 前回取得より古いポストを取得したらループを抜ける
          if (
            !oldest ||
            !this.lastFetchDate ||
            new Date(oldest) <= new Date(this.lastFetchDate)
          ) {
            break
          } else if (limit === 100) {
            console.log(
              '上限まで投稿を取得しましたが、未取得の投稿が存在する可能性があります',
            )
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

        // 画像の有無をチェック
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

        try {
          await this.db
            .insertInto('post')
            .values(postsToCreate)
            .onConflict((oc) => oc.doNothing())
            .execute()
        } catch (err) {
          console.error(`[ERROR] DB挿入失敗: ${postsToCreate.uri}`, err)
        }
      }
    }

    // 今回のフェッチ時刻を記録
    this.lastFetchDate = new Date().toISOString()
    console.log(`[INFO] フェッチ完了: ${this.lastFetchDate} (UTC)`)
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
