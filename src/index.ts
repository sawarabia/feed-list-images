import dotenv from 'dotenv'
import FeedGenerator from './server'
import { AtpAgent } from '@atproto/api'
import { DidEntry } from './config'

dotenv.config()
const identifier = process.env.FEEDGEN_PUBLISHER_HANDLE!
const password = process.env.FEEDGEN_PUBLISH_APP_PASSWORD!
const agent = new AtpAgent({ service: 'https://bsky.social' })

async function fetchDidEntriesFromOwnLists(): Promise<DidEntry[]> {
  await agent.login({ identifier, password })

  const did = agent.session?.did
  if (!did) throw new Error('ログインに失敗しました')

  const res = await agent.app.bsky.graph.getLists({ actor: did })
  const lists = res.data.lists

  if (!lists || lists.length === 0) {
    return [] // リストがない場合は空配列を返す
  }

  const allEntries: DidEntry[] = []

  for (const list of lists) {
    let cursor: string | undefined = undefined

    do {
      const membersRes = await agent.app.bsky.graph.getList({
        list: list.uri,
        cursor,
      })

      const entries: DidEntry[] = membersRes.data.items.map((item) => ({
        did: item.subject.did,
        listUri: list.uri,
      }))
      allEntries.push(...entries)

      cursor = membersRes.data.cursor
    } while (cursor)
  }
  return allEntries
}
const run = async (didEntries: DidEntry[], agent: AtpAgent) => {
  const hostname = maybeStr(process.env.FEEDGEN_HOSTNAME) ?? 'example.com'
  const serviceDid =
    maybeStr(process.env.FEEDGEN_SERVICE_DID) ?? `did:web:${hostname}`
  const server = FeedGenerator.create({
    port: maybeInt(process.env.FEEDGEN_PORT) ?? 3000,
    listenhost: maybeStr(process.env.FEEDGEN_LISTENHOST) ?? 'localhost',
    sqliteLocation: maybeStr(process.env.FEEDGEN_SQLITE_LOCATION) ?? ':memory:',
    subscriptionEndpoint:
      maybeStr(process.env.FEEDGEN_SUBSCRIPTION_ENDPOINT) ??
      'wss://bsky.network',
    publisherDid:
      maybeStr(process.env.FEEDGEN_PUBLISHER_DID) ?? 'did:example:alice',
    subscriptionReconnectDelay:
      maybeInt(process.env.FEEDGEN_SUBSCRIPTION_RECONNECT_DELAY) ?? 3000,
    hostname,
    serviceDid,
    didEntries,
    agent,
  })
  await server.start()
  console.log(
    `🤖 running feed generator at http://${server.cfg.listenhost}:${server.cfg.port}`,
  )
}

const maybeStr = (val?: string) => {
  if (!val) return undefined
  return val
}

const maybeInt = (val?: string) => {
  if (!val) return undefined
  const int = parseInt(val, 10)
  if (isNaN(int)) return undefined
  return int
}

const main = async () => {
  const didEntries = await fetchDidEntriesFromOwnLists()
  if (didEntries !== undefined) {
    await run(didEntries, agent)
  }
}

main()
