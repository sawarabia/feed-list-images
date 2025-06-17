import dotenv from 'dotenv'
import inquirer from 'inquirer'
import { AtpAgent, BlobRef, AppBskyFeedDefs } from '@atproto/api'
import fs from 'fs/promises'
import { ids } from '../src/lexicon/lexicons'

const run = async () => {
  dotenv.config()

  if (!process.env.FEEDGEN_SERVICE_DID && !process.env.FEEDGEN_HOSTNAME) {
    throw new Error('Please provide a hostname in the .env file')
  }

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'recordName',
      message: 'Enter a short name for the record (will be shown in the feed\'s URL):',
      required: true,
    },
    {
      type: 'input',
      name: 'displayName',
      message: 'Enter a display name for your feed:',
      required: true,
    },
  ])
  if (!process.env.FEEDGEN_PUBLISHER_HANDLE || !process.env.FEEDGEN_PUBLISH_APP_PASSWORD) {
    throw new Error('Please provide your IDPW in the .env file')
  }
  const handle = process.env.FEEDGEN_PUBLISHER_HANDLE
  const password = process.env.FEEDGEN_PUBLISH_APP_PASSWORD

  // 残りは対話式から
  const { recordName, displayName } = answers

  // 任意項目は undefined のままにしておく
  const description = undefined
  const avatar: any = undefined
  const service = undefined
  const videoOnly = false

  const feedGenDid =
    process.env.FEEDGEN_SERVICE_DID ?? `did:web:${process.env.FEEDGEN_HOSTNAME}`

  // only update this if in a test environment
  const agent = new AtpAgent({ service: service ? service : 'https://bsky.social' })
  await agent.login({ identifier: handle, password })

  let avatarRef: BlobRef | undefined
  if (avatar !== undefined) {
    let encoding: string
    if (avatar.endsWith('png')) {
      encoding = 'image/png'
    } else if (avatar.endsWith('jpg') || avatar.endsWith('jpeg')) {
      encoding = 'image/jpeg'
    } else {
      throw new Error('expected png or jpeg')
    }
    const img = await fs.readFile(avatar)
    const blobRes = await agent.api.com.atproto.repo.uploadBlob(img, {
      encoding,
    })
    avatarRef = blobRes.data.blob
  }

  await agent.api.com.atproto.repo.putRecord({
    repo: agent.session?.did ?? '',
    collection: ids.AppBskyFeedGenerator,
    rkey: recordName,
    record: {
      did: feedGenDid,
      displayName: displayName,
      description: description,
      avatar: avatarRef,
      createdAt: new Date().toISOString(),
      contentMode: videoOnly ? AppBskyFeedDefs.CONTENTMODEVIDEO : AppBskyFeedDefs.CONTENTMODEUNSPECIFIED,
    },
  })

  console.log('All done 🎉')
}

run()
