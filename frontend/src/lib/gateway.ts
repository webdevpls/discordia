type Handler = (t: string, d: any) => void

/** Single websocket to the backend with automatic reconnect. */
export class Gateway {
  private ws: WebSocket | null = null
  private token: string
  private handler: Handler
  private onStatus: (connected: boolean) => void
  private retry = 0
  private closed = false
  private timer: number | undefined

  constructor(token: string, handler: Handler, onStatus: (connected: boolean) => void) {
    this.token = token
    this.handler = handler
    this.onStatus = onStatus
    this.connect()
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.onStatus(true)
    }
    ws.onmessage = (e) => {
      try {
        const { t, d } = JSON.parse(e.data)
        this.handler(t, d)
      } catch (err) {
        console.error('gateway', err)
      }
    }
    ws.onclose = () => {
      this.ws = null
      this.onStatus(false)
      if (this.closed) return
      const delay = Math.min(10_000, 500 * 2 ** this.retry++)
      this.timer = window.setTimeout(() => this.connect(), delay)
    }
  }

  send(t: string, d?: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t, d }))
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.ws?.close()
  }
}
