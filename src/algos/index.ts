import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { createHash } from 'crypto'
import { createListHandler } from './lists'
import dotenv from 'dotenv'

dotenv.config()
// 環境変数からリストURI配列を取得
const listUris = process.env.FEEDGEN_LIST_URIS?.split(',')
if (!listUris) {
  throw new Error('リストが設定されていません')
}

const algos = Object.fromEntries(
  listUris.map((uri) => {
    const handler = createListHandler(uri)
    const shortname = createHash('sha256')
      .update(uri)
      .digest('hex')
      .slice(0, 16)
    return [shortname, handler]
  }),
)

export default algos
