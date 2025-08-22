import { createHash } from 'crypto'
import { createListHandler } from './lists'
import dotenv from 'dotenv'

dotenv.config()
const listUris = process.env.FEEDGEN_LIST_URIS?.split(',')
if (!listUris) {
  throw new Error('リストが設定されていません')
}

const algos = Object.fromEntries(
  listUris.map((uri) => {
    const handler = createListHandler(uri)
    // shortnameはlistUriをハッシュ化したもの
    const shortname = createHash('sha256')
      .update(uri)
      .digest('hex')
      .slice(0, 16)
    return [shortname, handler]
  }),
)

export default algos
