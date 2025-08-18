import { AtpAgent } from '@atproto/api'
import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import { Database } from './db'
import dotenv from 'dotenv'
import { QueryParams as QueryParamsFeeds } from './lexicon/types/app/bsky/feed/getAuthorFeed'
import { createHash } from 'crypto'

// このクラスは使わない
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

export class ListMembersSubscription {
  agent: AtpAgent
  private actors_arr: { did: string; listUri: string }[] = []
  private lastFetchDate: string | null = null // yyyy-mm-dd

  constructor(public db: Database) {
    this.agent = new AtpAgent({
      service: 'https://bsky.social',
    })
  }

  async run() {
    await this.updateActorsIfNeeded() // 初回ユーザー取得
    await this.reload() // 初回投稿取得
  }

  // 取得対象ユーザーは1日1回更新
  private async updateActorsIfNeeded() {
    const today = new Date().toISOString().slice(0, 10) // yyyy-mm-dd
    if (this.lastFetchDate === today && this.actors_arr.length > 0) return

    dotenv.config()
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
    lists.map((uri) => {
      const shortname = createHash('sha256')
        .update(uri)
        .digest('hex')
        .slice(0, 16)
      console.log(shortname)
    })
    const newActors: { did: string; listUri: string }[] = []

    for (const list of lists) {
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
    this.lastFetchDate = today
    console.log(this.lastFetchDate)
  }

  // 投稿取得（10分ごと定期実行）
  async reload() {
    await this.updateActorsIfNeeded()

    for (let actor of this.actors_arr) {
      const params_feed: QueryParamsFeeds = {
        actor: actor.did,
        limit: 25,
        filter: 'posts_with_media', // ToDo リプライを除く処理を追加
      }

      try {
        const { data: data_feed } = await this.agent.getAuthorFeed(params_feed)
        const postsArray = data_feed.feed

        for (let post of postsArray) {
          const postsToCreate = {
            uri: post.post.uri,
            cid: post.post.cid,
            listUri: actor.listUri,
            indexedAt: post.post.indexedAt,
          }

          await this.db
            .insertInto('post')
            .values(postsToCreate)
            .onConflict((oc) => oc.doNothing())
            .execute()
        }
      } catch (e) {
        // 10分後に取り直せる可能性が高いのでリトライはしない
        console.warn(`[WARN] 投稿取得失敗: ${actor.did} - ${e}`)
      }
    }
    console.log('fetched posts')
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
  }, 10 * 60 * 1000) // 10分ごと
}
