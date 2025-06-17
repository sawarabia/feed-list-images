import { Database } from './db'
import { DidResolver } from '@atproto/identity'
import { AtpAgent } from '@atproto/api'

export type DidEntry = {
  did: string
  listUri: string
}

export type AppContext = {
  db: Database
  didResolver: DidResolver
  cfg: Config
}

export type Config = {
  port: number
  listenhost: string
  hostname: string
  sqliteLocation: string
  subscriptionEndpoint: string
  serviceDid: string
  publisherDid: string
  subscriptionReconnectDelay: number
  didEntries: DidEntry[]
  agent: AtpAgent
}
