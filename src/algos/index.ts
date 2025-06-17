import { AppContext } from '../config'
import {
  QueryParams,
  OutputSchema as AlgoOutput,
} from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import * as india from './india'
import * as november from './november'
import * as charlie from './charlie'

type AlgoHandler = (ctx: AppContext, params: QueryParams) => Promise<AlgoOutput>

const algos: Record<string, AlgoHandler> = {
  [india.shortname]: india.handler,
  [november.shortname]: november.handler,
  [charlie.shortname]: charlie.handler,
}

export default algos
