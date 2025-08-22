import dotenv from 'dotenv'
import { AtpAgent, BlobRef } from '@atproto/api'
import fs from 'fs/promises'
import { ids } from '../src/lexicon/lexicons'
import inquirer from 'inquirer'
import { createHash } from 'crypto'

const run = async () => {
  dotenv.config()
  if (
    !process.env.FEEDGEN_PUBLISHER_HANDLE ||
    !process.env.FEEDGEN_PUBLISH_APP_PASSWORD
  ) {
    throw new Error('環境変数 IDENTIFIER または PASSWORD が設定されていません')
  }

  const handle = process.env.FEEDGEN_PUBLISHER_HANDLE
  const password = process.env.FEEDGEN_PUBLISH_APP_PASSWORD
  const answers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message:
        'Are you sure you want to delete this record? Any likes that your feed has will be lost:',
      default: false,
    },
  ])

  const { confirm } = answers

  if (!confirm) {
    console.log('Aborting...')
    return
  }

  const service = undefined // only update this if in a test environment
  const agent = new AtpAgent({
    service: service ? service : 'https://bsky.social',
  })
  await agent.login({ identifier: handle, password })
  const listUris = (process.env.FEEDGEN_LIST_URIS?.split(',') || []).filter(
    Boolean,
  )
  if (listUris.length === 0) {
    throw new Error('リストが設定されていません')
  }

  for (const listUri of listUris) {
    // shortnameはlistUriをハッシュ化したもの
    const shortname = createHash('sha256')
      .update(listUri)
      .digest('hex')
      .slice(0, 16)
    await agent.com.atproto.repo.deleteRecord({
      repo: agent.session?.did ?? '',
      collection: ids.AppBskyFeedGenerator,
      rkey: shortname,
    })
  }
  console.log('All done 🎉')
}

run()
