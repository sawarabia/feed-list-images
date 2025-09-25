import http from 'http'
import events from 'events'
import express from 'express'
import { DidResolver, MemoryCache } from '@atproto/identity'
import { createServer } from './lexicon'
import feedGeneration from './methods/feed-generation'
import describeGenerator from './methods/describe-generator'
import { createDb, Database, migrateToLatest } from './db'
import { ListMembersSubscription } from './subscription'
import { AppContext, Config, List } from './config'
import wellKnown from './well-known'
import { AtpAgent } from '@atproto/api'
import { createHash } from 'crypto'

export class FeedGenerator {
  public app: express.Application
  public server?: http.Server
  public db: Database
  public actorsfeed: ListMembersSubscription
  public cfg: Config
  public agent: AtpAgent
  public lists: List[]

  constructor(
    app: express.Application,
    db: Database,
    actorsfeed: ListMembersSubscription,
    cfg: Config,
    lists: List[],
  ) {
    this.app = app
    this.db = db
    this.actorsfeed = actorsfeed
    this.cfg = cfg
    this.lists = lists
  }

  static async create(cfg: Config): Promise<FeedGenerator> {
    const agent = new AtpAgent({
      service: 'https://bsky.social',
    })
    try {
      await agent.login({
        identifier: cfg.publisherDid,
        password: cfg.appPassword,
      })
    } catch (e) {
      console.error('ログイン失敗:', e)
      throw new Error('ログインに失敗しました')
    }
    const app = express()
    const db = createDb(cfg.sqliteLocation)
    const res = await agent.app.bsky.graph.getLists({ actor: cfg.publisherDid })
    const lists: List[] = res.data.lists.map((list) => ({
      uri: list.uri,
      shortname: createHash('sha256')
        .update(list.uri)
        .digest('hex')
        .slice(0, 16),
    }))
    // const firehose = new FirehoseSubscription(db, cfg.subscriptionEndpoint)
    const actorsfeed = new ListMembersSubscription(agent, db, cfg, lists)
    const didCache = new MemoryCache()
    const didResolver = new DidResolver({
      plcUrl: 'https://plc.directory',
      didCache,
    })

    const server = createServer({
      validateResponse: true,
      payload: {
        jsonLimit: 100 * 1024, // 100kb
        textLimit: 100 * 1024, // 100kb
        blobLimit: 5 * 1024 * 1024, // 5mb
      },
    })
    const ctx: AppContext = {
      db,
      didResolver,
      cfg,
      lists,
    }
    feedGeneration(server, ctx)
    describeGenerator(server, ctx)
    app.use(server.xrpc.router)
    app.use(wellKnown(ctx))

    return new FeedGenerator(app, db, actorsfeed, cfg, lists)
  }

  async start(): Promise<http.Server> {
    await migrateToLatest(this.db)
    this.actorsfeed.run()
    this.server = this.app.listen(this.cfg.port, this.cfg.listenhost)
    await events.once(this.server, 'listening')
    return this.server
  }
}

export default FeedGenerator
