import { sql } from 'kysely'
import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'

// max 15 chars
export const shortname = 'charlie'

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const listUri =
    'at://did:plc:bwzpz5v4meapwnrjjfbhds6m/app.bsky.graph.list/3l7vh66pafr2i'

    const postQuery = ctx.db
    .selectFrom('post')
    .select([
      'postUri',
      'cid',
      'indexedAt',
    ])
    .where('listUri', '=', listUri)

  const repostQuery = ctx.db
    .selectFrom('repost')
    .select([
      'postUri',
      'cid',
      'indexedAt',
    ])
    .where('listUri', '=', listUri)

  let unifiedQuery = ctx.db
  .selectFrom(
    postQuery
      .unionAll(repostQuery).as('u')
  )
  .selectAll()
  .orderBy('indexedAt', 'desc')
  .orderBy('cid', 'desc')
  .limit(params.limit)

  if (params.cursor) {
    const timeStr = new Date(parseInt(params.cursor, 10)).toISOString()
    unifiedQuery = unifiedQuery.where('indexedAt', '<', timeStr)
  }
console.log('unifiedQuery:', unifiedQuery)
  const res = await unifiedQuery.execute()

  const feed = res.map((row) => ({
    post: row.postUri,
  }))
  console.log('feed:', feed)
  let cursor: string | undefined
  const last = res.at(-1)
  if (last) {
    cursor = new Date(last.indexedAt).getTime().toString(10)
  }

  return {
    cursor,
    feed,
  }
}