import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import { AtpAgent } from '@atproto/api'

// Blueskyエージェントの初期化
const agent = new AtpAgent({ service: 'https://bsky.social' })
await agent.login({ identifier: 'your-identifier', password: 'your-password' })

// リストのURIを指定
const listUris = [
  'at://did:plc:example1/app.bsky.graph.list/list1',
  'at://did:plc:example2/app.bsky.graph.list/list2',
]

let cursor: string | undefined = undefined
const allDids = new Set<string>()

for (const listUri of listUris) {
  let cursor: string | undefined = undefined

  while (true) {
    const res = await agent.app.bsky.graph.getList({
      list: listUri,
      limit: 100,
      cursor,
    })

    for (const item of res.data.items) {
      allDids.add(item.subject.did)
    }

    if (res.data.cursor) {
      cursor = res.data.cursor
    } else {
      break
    }
  }
}
export class FirehoseSubscription extends FirehoseSubscriptionBase {
  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const ops = await getOpsByType(evt)

    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate = ops.posts.creates
      .filter((create) => {
        const did = create.author.did
        const hasImage = create.record.embed?.images?.length > 0
        return allowedDids.has(did) && hasImage
      })
      .map((create) => {
        // map alf-related posts to a db row
        return {
          uri: create.uri,
          cid: create.cid,
          indexedAt: new Date().toISOString(),
        }
      })

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
