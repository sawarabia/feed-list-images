import dotenv from 'dotenv'
import { AtpAgent, BlobRef, AppBskyFeedDefs } from '@atproto/api'
import fs from 'fs/promises'
import { ids } from '../src/lexicon/lexicons'
import inquirer from 'inquirer'
import { createHash } from 'crypto'

const run = async () => {
  dotenv.config()

  // 必須の環境変数チェック
  if (
    !process.env.FEEDGEN_PUBLISHER_HANDLE ||
    !process.env.FEEDGEN_PUBLISH_APP_PASSWORD
  ) {
    throw new Error('Please provide your IDPW in the .env file')
  }

  const handle = process.env.FEEDGEN_PUBLISHER_HANDLE
  const password = process.env.FEEDGEN_PUBLISH_APP_PASSWORD

  // 任意項目
  const description = undefined
  const avatar: any = undefined // アバター画像のパス（任意）
  const service = undefined
  const videoOnly = false

  const feedGenDid = `did:web:${process.env.FEEDGEN_PUBLUSH_HOSTNAME}`
  // ログイン
  const agent = new AtpAgent({
    service: service ?? 'https://bsky.social',
  })
  await agent.login({ identifier: handle, password })

  const listUris = (process.env.FEEDGEN_LIST_URIS?.split(',') || []).filter(
    Boolean,
  )
  if (listUris.length === 0) {
    throw new Error('リストが設定されていません')
  }

  for (const listUri of listUris) {
    // リスト情報の取得
    let displayName: string | undefined
    try {
      const res = await agent.app.bsky.graph.getList({ list: listUri })
      displayName = res.data.list.name
    } catch (err) {
      console.error(`リスト取得エラー:`, err)
      continue
    }

    // アバター画像のアップロード（任意）
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

    // rkey をハッシュから生成（listUri → 16文字のSHA256ハッシュ）
    const rkey = createHash('sha256').update(listUri).digest('hex').slice(0, 16)

    // フィードジェネレーター登録
    try {
      await agent.com.atproto.repo.putRecord({
        repo: agent.session?.did ?? '',
        collection: ids.AppBskyFeedGenerator,
        rkey: rkey,
        record: {
          did: feedGenDid,
          displayName: displayName,
          description: description,
          avatar: avatarRef,
          createdAt: new Date().toISOString(),
          contentMode: videoOnly
            ? AppBskyFeedDefs.CONTENTMODEVIDEO
            : AppBskyFeedDefs.CONTENTMODEUNSPECIFIED,
        },
      })

      console.log(`登録完了: ${displayName}`)
    } catch (err) {
      console.error(`登録エラー: ${feedGenDid}`, err)
    }
  }

  console.log('All done 🎉')
}

run()
