export type User = { id: number; username: string }
export type Member = User & { online: boolean }

export type Group = { id: number; name: string; owner_id: number; invite_code: string }

export type ChannelKind = 'text' | 'voice'
export type Channel = { id: number; group_id: number; name: string; kind: ChannelKind }

export type Message = {
  id: number
  channel_id: number
  author: User
  content: string
  created_at: string
}

export type VoiceUser = {
  user_id: number
  muted: boolean
  deafened: boolean
  camera: boolean
  screen: boolean
}

export type Source = 'mic' | 'camera' | 'screen' | 'screen-audio'
