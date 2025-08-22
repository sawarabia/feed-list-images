import dotenv from 'dotenv'
import { AtpAgent } from '@atproto/api'

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
  const agent = new AtpAgent({
    service: 'https://bsky.social',
  })
  await agent.login({ identifier: handle, password })

  try {
    const { data: data_feed } = await agent.getAuthorFeed({
      actor: 'uouok.bsky.social',
      limit: 20,
      filter: 'posts_with_replies',
    })
    const postsArray = data_feed.feed
    console.log(postsArray)
  } catch (err) {
    console.error(`取得エラー:`, err)
  }
}

run()
