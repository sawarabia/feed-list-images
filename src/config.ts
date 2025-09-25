import { AtpAgent } from '@atproto/api'
import { Database } from './db'
import { DidResolver } from '@atproto/identity'

export type AppContext = {
  db: Database
  didResolver: DidResolver
  cfg: Config
  lists: List[]
}

export type Config = {
  appPassword: string
  port: number
  listenhost: string
  hostname: string
  sqliteLocation: string
  subscriptionEndpoint: string
  serviceDid: string
  publisherDid: string
  subscriptionReconnectDelay: number
}

export type List = {
  uri: string
  shortname: string
}
