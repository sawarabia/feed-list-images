export type DatabaseSchema = {
  post: Post
  sub_state: SubState
}

export type Post = {
  postUri: string
  cid: string
  indexedAt: string
  listUri: string
  postType: string
  repostUri: string | null
}

export type SubState = {
  service: string
  cursor: number
}