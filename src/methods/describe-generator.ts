import { Server } from '../lexicon'
import { AppContext } from '../config'
import algos from '../algos/createFeedHandler'
import { AtUri } from '@atproto/syntax'
import { AtpAgent } from '@atproto/api'
import { createHash } from 'crypto'
import dotenv from 'dotenv'

dotenv.config()
export default function (server: Server, ctx: AppContext) {
  server.app.bsky.feed.describeFeedGenerator(async () => {
    const feeds = Object.keys(ctx.lists).map((shortname) => ({
      uri: AtUri.make(
        ctx.cfg.publisherDid,
        'app.bsky.feed.generator',
        shortname,
      ).toString(),
    }))
    return {
      encoding: 'application/json',
      body: {
        did: ctx.cfg.serviceDid,
        feeds,
      },
    }
  })
}
