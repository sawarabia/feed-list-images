export type DatabaseSchema = {
  post: Post
  repost: Repost
  sub_state: SubState
}

export type Post = {
  postUri: string
  cid: string
  indexedAt: string
  listUri: string
}

export type Repost = {
  postUri: string
  cid: string
  indexedAt: string
  listUri: string
  repostUri: string
}

export type SubState = {
  service: string
  cursor: number
}