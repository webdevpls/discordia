import { create } from 'zustand'
import { api, getToken, setToken } from './lib/api'
import { Gateway } from './lib/gateway'
import { VoiceSession, type Quality, type ScreenOptions } from './lib/rtc'
import { setSoundOutput, sounds } from './lib/sounds'
import type { Channel, Group, Member, Message, User, VoiceUser } from './lib/types'

type GroupDetail = { channels: Channel[]; members: Member[] }

type VoiceUI = {
  channelId: number
  groupId: number
  muted: boolean
  deafened: boolean
  camera: boolean
  screen: boolean
  hasMic: boolean
}

type State = {
  me: User | null
  booting: boolean
  connected: boolean
  groups: Group[]
  details: Record<number, GroupDetail>
  users: Record<number, User>
  online: Record<number, boolean>
  activeGroupId: number | null
  activeChannelId: number | null
  messages: Record<number, Message[]>
  hasMore: Record<number, boolean>
  typing: Record<number, Record<number, number>> // channel -> user -> expires at
  voiceStates: Record<number, VoiceUser[]>
  iceServers: RTCIceServer[]
  voice: VoiceUI | null
  streams: Record<string, MediaStream>
  speaking: Record<number, boolean>
  toast: string | null
  /** Chosen deviceIds; "" = system default. */
  audioInput: string
  audioOutput: string
  /** RNNoise on the mic (preference, saved per machine). */
  noiseSuppression: boolean
  /** Live connection quality while in a call. */
  netQuality: Quality | null
  /** Listener-side volume per audio stream ("userId|mic", "userId|screen-audio"), 0..1, saved per machine. */
  volumes: Record<string, number>
  /** The "share your screen" picker is open. */
  screenPicker: boolean
}

const initial: State = {
  me: null,
  booting: true,
  connected: false,
  groups: [],
  details: {},
  users: {},
  online: {},
  activeGroupId: null,
  activeChannelId: null,
  messages: {},
  hasMore: {},
  typing: {},
  voiceStates: {},
  iceServers: [],
  voice: null,
  streams: {},
  speaking: {},
  toast: null,
  netQuality: null,
  volumes: recallVolumes(),
  screenPicker: false,
  ...recallDevices(),
}

export const useStore = create<State>(() => initial)
const set = useStore.setState
const get = useStore.getState

let gateway: Gateway | null = null
let session: VoiceSession | null = null
let toastTimer: number | undefined

const LAST_KEY = 'discordia.last'

function remember(groupId: number | null, channelId: number | null) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ groupId, channelId }))
  } catch {
    /* ignore */
  }
}

function recall(): { groupId?: number; channelId?: number } {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}')
  } catch {
    return {}
  }
}

// Function declarations are hoisted, so `initial` can use this before it's defined.
function recallDevices(): { audioInput: string; audioOutput: string; noiseSuppression: boolean } {
  try {
    const d = JSON.parse(localStorage.getItem('discordia.devices') ?? '{}')
    return { audioInput: d.audioInput ?? '', audioOutput: d.audioOutput ?? '', noiseSuppression: d.noiseSuppression ?? true }
  } catch {
    return { audioInput: '', audioOutput: '', noiseSuppression: true }
  }
}

function recallVolumes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem('discordia.volumes') ?? '{}')
  } catch {
    return {}
  }
}

export function setVolume(key: string, volume: number) {
  const volumes = { ...get().volumes, [key]: Math.min(1, Math.max(0, volume)) }
  set({ volumes })
  try {
    localStorage.setItem('discordia.volumes', JSON.stringify(volumes))
  } catch {
    /* ignore */
  }
}

function rememberDevices() {
  const { audioInput, audioOutput, noiseSuppression } = get()
  try {
    localStorage.setItem('discordia.devices', JSON.stringify({ audioInput, audioOutput, noiseSuppression }))
  } catch {
    /* ignore */
  }
}

function indexUsers(list: User[]) {
  const users = { ...get().users }
  for (const u of list) users[u.id] = { id: u.id, username: u.username }
  set({ users })
}

export function toast(message: string) {
  set({ toast: message })
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => set({ toast: null }), 3500)
}

// ---------- auth ----------

export async function boot() {
  if (!getToken()) return set({ booting: false })
  try {
    const { user, groups } = await api<{ user: User; groups: Group[] }>('GET', '/me')
    await enter(user, groups)
  } catch {
    setToken(null)
  }
  set({ booting: false })
}

export async function authenticate(mode: 'login' | 'register', username: string, password: string) {
  const { token, user } = await api<{ token: string; user: User }>('POST', `/auth/${mode}`, { username, password })
  setToken(token)
  const { groups } = await api<{ groups: Group[] }>('GET', '/me')
  await enter(user, groups)
}

async function enter(user: User, groups: Group[]) {
  set({ me: user, groups })
  indexUsers([user])
  gateway?.close()
  gateway = new Gateway(getToken()!, onEvent, (connected) => {
    set({ connected })
    if (!connected) endSession() // the server drops voice when the socket dies
  })
  const last = recall()
  const g = groups.find((x) => x.id === last.groupId) ?? groups[0]
  if (g) await openGroup(g.id, last.channelId)
}

export async function logout() {
  endSession()
  gateway?.close()
  gateway = null
  await api('POST', '/auth/logout').catch(() => {})
  setToken(null)
  // Devices belong to this machine, not the account.
  set({ ...initial, ...recallDevices(), booting: false })
}

// ---------- groups & channels ----------

export async function openGroup(groupId: number, preferChannel?: number) {
  set({ activeGroupId: groupId })
  let detail: GroupDetail | undefined = get().details[groupId]
  if (!detail) {
    detail = await loadGroup(groupId)
    if (!detail) return
  }
  const ch =
    detail.channels.find((c) => c.id === preferChannel) ??
    detail.channels.find((c) => c.kind === 'text') ??
    detail.channels[0]
  if (ch) openChannel(ch)
}

async function loadGroup(groupId: number): Promise<GroupDetail | undefined> {
  try {
    const r = await api<{ group: Group; channels: Channel[]; members: Member[] }>('GET', `/groups/${groupId}`)
    const detail = { channels: r.channels, members: r.members }
    const online = { ...get().online }
    for (const m of r.members) if (m.online) online[m.id] = true
    set({ details: { ...get().details, [groupId]: detail }, online })
    indexUsers(r.members)
    return detail
  } catch {
    set({ groups: get().groups.filter((g) => g.id !== groupId) })
  }
}

export function openChannel(ch: Channel) {
  if (ch.kind === 'voice' && get().voice?.channelId !== ch.id) void joinVoice(ch)
  set({ activeChannelId: ch.id, activeGroupId: ch.group_id })
  // Only text channels are restored on reload — reopening a voice channel would auto-join the call.
  if (ch.kind === 'text') remember(ch.group_id, ch.id)
  if (ch.kind === 'text' && !get().messages[ch.id]) void loadMessages(ch.id)
}

export async function createGroup(name: string) {
  const g = await api<Group>('POST', '/groups', { name })
  set({ groups: [...get().groups, g] })
  await openGroup(g.id)
}

export async function joinGroup(code: string) {
  const g = await api<Group>('POST', '/groups/join', { invite_code: code })
  if (!get().groups.some((x) => x.id === g.id)) set({ groups: [...get().groups, g] })
  await loadGroup(g.id)
  await openGroup(g.id)
}

export async function leaveGroup(groupId: number) {
  await api('DELETE', `/groups/${groupId}/members/me`)
  dropGroup(groupId)
}

function dropGroup(groupId: number) {
  if (get().voice?.groupId === groupId) leaveVoice()
  const groups = get().groups.filter((g) => g.id !== groupId)
  set({ groups })
  if (get().activeGroupId === groupId) {
    set({ activeGroupId: null, activeChannelId: null })
    if (groups[0]) void openGroup(groups[0].id)
  }
}

export async function createChannel(groupId: number, name: string, kind: 'text' | 'voice') {
  const ch = await api<Channel>('POST', `/groups/${groupId}/channels`, { name, kind })
  addChannel(ch)
  if (kind === 'text') openChannel(ch)
}

export async function deleteChannel(id: number) {
  await api('DELETE', `/channels/${id}`)
}

function addChannel(ch: Channel) {
  const d = get().details[ch.group_id]
  if (!d || d.channels.some((c) => c.id === ch.id)) return
  set({ details: { ...get().details, [ch.group_id]: { ...d, channels: [...d.channels, ch] } } })
}

// ---------- messages ----------

export async function loadMessages(channelId: number, before?: number) {
  const q = before ? `?before=${before}` : ''
  const msgs = await api<Message[]>('GET', `/channels/${channelId}/messages${q}`)
  indexUsers(msgs.map((m) => m.author))
  const cur = before ? (get().messages[channelId] ?? []) : []
  set({
    messages: { ...get().messages, [channelId]: [...msgs, ...cur] },
    hasMore: { ...get().hasMore, [channelId]: msgs.length === 50 },
  })
}

export async function sendMessage(channelId: number, content: string) {
  const msg = await api<Message>('POST', `/channels/${channelId}/messages`, { content })
  pushMessage(msg)
}

function pushMessage(msg: Message) {
  const list = get().messages[msg.channel_id]
  if (!list || list.some((m) => m.id === msg.id)) return
  const typing = { ...get().typing }
  if (typing[msg.channel_id]) {
    typing[msg.channel_id] = { ...typing[msg.channel_id] }
    delete typing[msg.channel_id][msg.author.id]
  }
  set({ messages: { ...get().messages, [msg.channel_id]: [...list, msg] }, typing })
}

let lastTyping = 0
export function notifyTyping(channelId: number) {
  const now = Date.now()
  if (now - lastTyping < 4000) return
  lastTyping = now
  gateway?.send('typing', { channel_id: channelId })
}

// ---------- voice ----------

export async function joinVoice(ch: Channel) {
  const me = get().me
  if (!me || !gateway) return
  endSession()
  const s = new VoiceSession(ch.id, me.id, get().iceServers, (t, d) => gateway?.send(t, d), {
    onStream: (key, stream) => {
      const streams = { ...get().streams }
      if (stream) streams[key] = stream
      else delete streams[key]
      set({ streams })
    },
    onSpeaking: (uid, on) => set({ speaking: { ...get().speaking, [uid]: on } }),
    onQuality: (q) => {
      const prev = get().netQuality?.level
      set({ netQuality: q })
      if (q.level === 'poor' && prev !== 'poor') toast('Conexão fraca: reduzindo o vídeo para manter a voz')
    },
  })
  s.onEnded = (src) => {
    if (src === 'camera') patchVoice({ camera: false })
    if (src === 'screen') patchVoice({ screen: false })
  }
  session = s
  videoSent = null
  set({
    voice: { channelId: ch.id, groupId: ch.group_id, muted: false, deafened: false, camera: false, screen: false, hasMic: true },
  })
  gateway.send('voice.join', { channel_id: ch.id })
  sendVideoWanted()
  const hasMic = await s.start(get().audioInput, get().noiseSuppression)
  if (session !== s) return
  patchVoice({ hasMic, muted: !hasMic })
  if (hasMic && get().noiseSuppression && !s.noiseSuppression) toast('Supressão de ruído indisponível neste navegador; usando a padrão')
  if (!hasMic) {
    toast('Microfone indisponível — você entrou só para ouvir')
    sendFlags()
  }
}

// Video keys the UI currently renders; the SFU only forwards these.
let videoWanted: string[] = []
let videoSent: string | null = null // null = nothing sent yet this session

export function setVideoWanted(keys: string[]) {
  videoWanted = [...keys].sort()
  sendVideoWanted()
}

function sendVideoWanted() {
  if (!session) return
  // A hidden tab shows nothing, so it receives (and decodes) no video at all.
  const keys = document.hidden ? [] : videoWanted
  const sig = keys.join(',')
  if (sig === videoSent) return
  videoSent = sig
  gateway?.send('rtc.sub.want', { video: keys })
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', sendVideoWanted)

export function leaveVoice() {
  if (!session) return
  if (!get().voice?.deafened) sounds.selfLeave()
  gateway?.send('voice.leave')
  endSession()
}

function endSession() {
  session?.close()
  session = null
  videoSent = null
  if (get().voice) set({ voice: null, streams: {}, speaking: {}, netQuality: null, screenPicker: false })
}

function patchVoice(p: Partial<VoiceUI>) {
  const v = get().voice
  if (v) set({ voice: { ...v, ...p } })
}

function sendFlags() {
  const v = get().voice
  if (v) gateway?.send('voice.flags', { muted: v.muted, deafened: v.deafened })
}

export function toggleMute() {
  const v = get().voice
  if (!v || !v.hasMic) return
  const muted = !v.muted
  // Unmuting while deafened also undeafens, like Discord.
  patchVoice({ muted, deafened: muted ? v.deafened : false })
  session?.setMuted(muted)
  sendFlags()
}

export function toggleDeafen() {
  const v = get().voice
  if (!v) return
  const deafened = !v.deafened
  const muted = deafened || !v.hasMic ? true : false
  patchVoice({ deafened, muted })
  session?.setMuted(muted)
  sendFlags()
}

export async function setAudioInput(deviceId: string) {
  set({ audioInput: deviceId })
  rememberDevices()
  const v = get().voice
  if (!session || !v?.hasMic) return
  try {
    await session.switchMic(deviceId)
  } catch {
    toast('Não foi possível usar esse microfone')
  }
}

export async function toggleNoiseSuppression() {
  const on = !get().noiseSuppression
  set({ noiseSuppression: on })
  rememberDevices()
  if (!session || !get().voice?.hasMic) return
  try {
    const active = await session.setNoiseSuppression(on)
    if (on && !active) toast('Supressão de ruído indisponível neste navegador; usando a padrão')
  } catch {
    toast('Não foi possível reabrir o microfone')
  }
}

/** Applied by every <audio> in AudioSink via setSinkId. */
export function setAudioOutput(deviceId: string) {
  set({ audioOutput: deviceId })
  rememberDevices()
  setSoundOutput(deviceId)
}

export async function toggleCamera() {
  if (!session) return
  try {
    patchVoice({ camera: await session.toggleCamera() })
  } catch {
    toast('Não foi possível acessar a câmera')
  }
}

/** Stops the share, or opens the picker to start one. */
export async function toggleScreen() {
  if (!session) return
  if (get().voice?.screen) {
    await session.stopScreen()
    patchVoice({ screen: false })
  } else {
    openScreenPicker()
  }
}

export function openScreenPicker() {
  if (session) set({ screenPicker: true })
}

export function closeScreenPicker() {
  set({ screenPicker: false })
}

export async function shareScreen(opts: ScreenOptions) {
  if (!session) return
  set({ screenPicker: false })
  try {
    await session.startScreen(opts)
    patchVoice({ screen: true })
  } catch (err) {
    if ((err as DOMException)?.name !== 'NotAllowedError') toast('Não foi possível compartilhar a tela')
  }
}

// ---------- gateway events ----------

function onEvent(t: string, d: any) {
  const s = get()
  switch (t) {
    case 'ready': {
      const online: Record<number, boolean> = { [d.user.id]: true }
      for (const id of d.online as number[]) online[id] = true
      const voiceStates: Record<number, VoiceUser[]> = {}
      for (const [cid, users] of Object.entries(d.voice as Record<string, VoiceUser[]>)) voiceStates[Number(cid)] = users
      set({ online, voiceStates, iceServers: d.ice_servers })
      // Refresh caches after a reconnect so nothing is stale.
      if (s.activeGroupId) void loadGroup(s.activeGroupId)
      const ch = s.activeChannelId
      if (ch && s.messages[ch]) void loadMessages(ch)
      set({ messages: ch && s.messages[ch] ? { [ch]: s.messages[ch] } : {} })
      break
    }
    case 'presence': {
      set({ online: { ...s.online, [d.user_id]: d.online } })
      break
    }
    case 'message.create':
      indexUsers([d.author])
      pushMessage(d)
      break
    case 'typing': {
      if (d.user.id === s.me?.id) break
      const ch = { ...(s.typing[d.channel_id] ?? {}), [d.user.id]: Date.now() + 6000 }
      indexUsers([d.user])
      set({ typing: { ...s.typing, [d.channel_id]: ch } })
      break
    }
    case 'channel.create':
      addChannel(d)
      break
    case 'channel.delete': {
      const det = s.details[d.group_id]
      if (det) set({ details: { ...s.details, [d.group_id]: { ...det, channels: det.channels.filter((c) => c.id !== d.id) } } })
      if (s.voice?.channelId === d.id) leaveVoice()
      if (s.activeChannelId === d.id) void openGroup(d.group_id)
      break
    }
    case 'member.join': {
      indexUsers([d.user])
      const det = s.details[d.group_id]
      if (det && !det.members.some((m) => m.id === d.user.id)) {
        const members = [...det.members, { ...d.user, online: true }].sort((a, b) => a.username.localeCompare(b.username))
        set({ details: { ...s.details, [d.group_id]: { ...det, members } }, online: { ...s.online, [d.user.id]: true } })
      }
      break
    }
    case 'member.leave': {
      if (d.user_id === s.me?.id) return dropGroup(d.group_id)
      const det = s.details[d.group_id]
      if (det) set({ details: { ...s.details, [d.group_id]: { ...det, members: det.members.filter((m) => m.id !== d.user_id) } } })
      break
    }
    case 'voice.state': {
      // Chime when someone else joins or leaves the call I'm in. Without a previous
      // snapshot (just reconnected) there's nothing to compare, so stay quiet.
      const prev = s.voiceStates[d.channel_id]
      if (s.voice && s.voice.channelId === d.channel_id && prev && !s.voice.deafened) {
        const others = (list: VoiceUser[]) => new Set(list.map((u) => u.user_id).filter((id) => id !== s.me?.id))
        const before = others(prev)
        const after = others(d.users)
        if ([...after].some((id) => !before.has(id))) sounds.join()
        else if ([...before].some((id) => !after.has(id))) sounds.leave()
      }
      const voiceStates = { ...s.voiceStates }
      if (d.users.length) voiceStates[d.channel_id] = d.users
      else delete voiceStates[d.channel_id]
      set({ voiceStates })
      break
    }
    case 'voice.joined':
      if (session?.channelId === d.channel_id) {
        setSoundOutput(s.audioOutput)
        sounds.selfJoin()
      }
      break
    case 'voice.left':
      if (session && session.channelId === d.channel_id) {
        if (!s.voice?.deafened) sounds.selfLeave()
        endSession()
        if (d.reason) toast('Conexão de voz perdida')
      }
      break
    case 'rtc.pub.answer':
      void session?.onPubAnswer(d.sdp)
      break
    case 'rtc.pub.candidate':
      session?.onPubCandidate(d)
      break
    case 'rtc.sub.offer':
      session?.onSubOffer(d.sdp)
      break
    case 'rtc.sub.candidate':
      session?.onSubCandidate(d)
      break
    case 'error':
      toast(d.message)
      break
  }
}
