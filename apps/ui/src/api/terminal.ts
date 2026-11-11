// Interactive shell in an agent's container: WS /api/agents/:id/terminal?token=&cols=&rows=
// Protocol (spikes/03-pty): binary frames = terminal data both ways; text JSON {type:'resize',cols,rows}.
// One session per open Inspector; output is buffered so the xterm view can unmount/remount
// (switching tabs) and the composer's "shell" mode can type into it without the tab open.
import { getToken } from './token'
import { wsUrl } from './client'

export type TermState = 'idle' | 'connecting' | 'open' | 'closed'
export interface TermStatus { state: TermState; reason?: string }

const MAX_BUFFER = 512 * 1024

export class TerminalSession {
  private ws: WebSocket | null = null
  private chunks: Uint8Array[] = []
  private bytes = 0
  private queue: Uint8Array[] = []
  private dataFns = new Set<(d: Uint8Array) => void>()
  private statusFns = new Set<(s: TermStatus) => void>()
  private size = { cols: 120, rows: 32 }
  private enc = new TextEncoder()
  status: TermStatus = { state: 'idle' }

  constructor(readonly agentId: string) {}

  private setStatus(s: TermStatus) { this.status = s; this.statusFns.forEach((fn) => fn(s)) }

  private push(d: Uint8Array) {
    this.chunks.push(d)
    this.bytes += d.byteLength
    while (this.bytes > MAX_BUFFER && this.chunks.length > 1) this.bytes -= this.chunks.shift()!.byteLength
    this.dataFns.forEach((fn) => fn(d))
  }

  /** Connect if not already connected (or connecting). */
  ensure(cols?: number, rows?: number) {
    if (cols && rows) this.size = { cols, rows }
    if (this.ws) return
    const token = getToken() ?? ''
    this.setStatus({ state: 'connecting' })
    let opened = false
    const ws = new WebSocket(wsUrl(`/api/agents/${encodeURIComponent(this.agentId)}/terminal`, { token, cols: this.size.cols, rows: this.size.rows }))
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      opened = true
      this.setStatus({ state: 'open' })
      ws.send(JSON.stringify({ type: 'resize', ...this.size })) // in case the view resized while connecting
      for (const q of this.queue.splice(0)) ws.send(q)
    }
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { this.push(new Uint8Array(ev.data)); return }
      if (typeof ev.data !== 'string') return
      try {
        const m = JSON.parse(ev.data) as { type?: string; message?: string; code?: number; reason?: string }
        if (m && typeof m.type === 'string') {
          if (m.type === 'exit') this.push(this.enc.encode(`\r\n[shell exited${m.code != null ? ` with code ${m.code}` : ''}]\r\n`))
          else if (m.type === 'error') this.push(this.enc.encode(`\r\n[error: ${m.message ?? 'unknown'}]\r\n`))
          return
        }
      } catch { /* plain text: show it */ }
      this.push(this.enc.encode(ev.data))
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.queue = []
      const reason = ev.reason || (opened
        ? (ev.code === 1000 ? 'session ended' : `connection lost (code ${ev.code})`)
        : "couldn't open a shell: the agent may be stopped, the token rejected, or 3 shells already open")
      this.setStatus({ state: 'closed', reason })
    }
  }

  /** Type into the shell (connects first if needed). */
  send(data: string | Uint8Array) {
    const bytes = typeof data === 'string' ? this.enc.encode(data) : data
    if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(bytes); return }
    this.queue.push(bytes)
    this.ensure()
  }

  resize(cols: number, rows: number) {
    if (!cols || !rows) return
    const changed = cols !== this.size.cols || rows !== this.size.rows
    this.size = { cols, rows }
    if (changed && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  }

  /** Subscribe to output; replays what was buffered so far. */
  onData(fn: (d: Uint8Array) => void) {
    for (const c of this.chunks) fn(c)
    this.dataFns.add(fn)
    return () => { this.dataFns.delete(fn) }
  }

  onStatus(fn: (s: TermStatus) => void) {
    this.statusFns.add(fn)
    return () => { this.statusFns.delete(fn) }
  }

  reconnect() {
    const ws = this.ws
    this.ws = null
    ws?.close(1000, 'reconnect')
    this.push(this.enc.encode('\r\n[reconnecting…]\r\n'))
    this.ensure()
  }

  close() {
    const ws = this.ws
    this.ws = null
    ws?.close(1000, 'inspector closed')
    this.dataFns.clear()
    this.statusFns.clear()
  }
}
