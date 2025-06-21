import { sql } from 'kysely'
import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'

// max 15 chars
export const shortname = 'india'

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const listUri =
    'at://did:plc:bwzpz5v4meapwnrjjfbhds6m/app.bsky.graph.list/3l7vh66pafr2i'

  // サブクエリ: uri ごとに indexedAt が最も古い（ROW_NUMBER = 1）のみを抽出
  const subquery = ctx.db
    .selectFrom('post')
    .select([
      'uri',
      'cid',
      'indexedAt',
      'listUri',
      sql`ROW_NUMBER() OVER (PARTITION BY uri ORDER BY indexedAt ASC)`.as('rn'),
    ])
    .where('listUri', 'like', listUri)

  // メインクエリ: 最古の投稿だけを対象にして、表示順は新しい順に
  let builder = ctx.db
    .selectFrom(subquery.as('t'))
    .selectAll()
    .where('rn', '=', 1)
    .orderBy('indexedAt', 'desc')
    .orderBy('cid', 'desc')
    .limit(params.limit)

  if (params.cursor) {
    const timeStr = new Date(parseInt(params.cursor, 10)).toISOString()
    builder = builder.where('indexedAt', '<', timeStr)
  }

  const res = await builder.execute()

  const feed = res.map((row) => ({
    post: row.uri,
  }))

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