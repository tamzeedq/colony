// WebSocket link to the control plane (`WS /api/runner`).
//
// - Authenticates with `Authorization: Bearer <agent token>`.
// - Every (re)connect starts with a fresh `hello` built by `hello()`, then flushes whatever
//   was buffered while disconnected, in order.
// - Reconnects forever with exponential backoff + jitter (0.5 s → 30 s).
// - Incoming frames are validated with `parseRunnerCommand`; invalid ones are logged and dropped.

import WebSocket from 'ws'
import { parseRunnerCommand, type RunnerCommand, type RunnerMessage } from '@colony/shared'
import type { Logger } from './log'

export interface ControlConnectionOptions {
  url: string
  token: string
  /** Builds the `hello` sent first on every connect (so it carries the current session id). */
  hello: () => RunnerMessage
  /** Messages sent right after `hello` + buffer flush on a REconnect (e.g. current status). */
  onReconnect?: () => RunnerMessage[]
  onCommand: (cmd: RunnerCommand) => void
  log: Logger
  /** Max messages kept while disconnected; the oldest are dropped beyond this. */
  maxBuffer?: number
  minBackoffMs?: number
  maxBackoffMs?: number
}

export class ControlConnection {
  private ws: WebSocket | undefined
  private buffer: string[] = []
  private attempt = 0
  private connectedOnce = false
  private closed = false
  private timer: NodeJS.Timeout | undefined
  private dropped = 0

  constructor(private readonly opts: ControlConnectionOptions) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start(): void {
    this.connect()
  }

  send(msg: RunnerMessage): void {
    const data = JSON.stringify(msg)
    if (this.connected) {
      this.ws!.send(data)
      return
    }
    this.buffer.push(data)
    const max = this.opts.maxBuffer ?? 10_000
    if (this.buffer.length > max) {
      this.buffer.splice(0, this.buffer.length - max)
      if (this.dropped++ % 1000 === 0) this.opts.log.warn(`outgoing buffer full (${max}); dropping oldest messages`)
    }
  }

  /** Flush what can be flushed (bounded by `timeoutMs`), then close for good. */
  async close(timeoutMs = 3000): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    const ws = this.ws
    if (!ws) return
    if (ws.readyState === WebSocket.OPEN) {
      const deadline = Date.now() + timeoutMs
      while (ws.bufferedAmount > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { ws.terminate(); resolve() }, Math.max(100, deadline - Date.now()))
        ws.once('close', () => { clearTimeout(t); resolve() })
        ws.close(1000, 'runner shutdown')
      })
    } else {
      ws.terminate()
    }
  }

  private connect(): void {
    if (this.closed) return
    const { log } = this.opts
    const ws = new WebSocket(this.opts.url, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
      handshakeTimeout: 10_000,
    })
    this.ws = ws

    ws.on('open', () => {
      const reconnect = this.connectedOnce
      this.connectedOnce = true
      this.attempt = 0
      log.info(`connected to control plane${reconnect ? ' (reconnect)' : ''}`)
      ws.send(JSON.stringify(this.opts.hello()))
      const pending = this.buffer
      this.buffer = []
      for (const data of pending) ws.send(data)
      if (reconnect) for (const m of this.opts.onReconnect?.() ?? []) ws.send(JSON.stringify(m))
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary) { log.warn('ignoring binary frame from control plane'); return }
      const r = parseRunnerCommand(data.toString())
      if (!r.ok) { log.warn('ignoring invalid command from control plane', r.error.slice(0, 300)); return }
      try {
        this.opts.onCommand(r.value)
      } catch (e) {
        log.error(`command handler failed for ${r.value.type}`, e)
      }
    })

    ws.on('unexpected-response', (_req, res) => {
      log.warn(`control plane rejected the connection: HTTP ${res.statusCode}`)
      ws.terminate()
    })

    ws.on('error', (err) => {
      // 'close' follows; just record why.
      if (this.attempt === 0 || this.attempt % 10 === 0) log.warn('control plane socket error', err)
    })

    ws.on('close', () => {
      if (this.ws === ws) this.ws = undefined
      if (this.closed) return
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    const min = this.opts.minBackoffMs ?? 500
    const max = this.opts.maxBackoffMs ?? 30_000
    const base = Math.min(max, min * 2 ** this.attempt)
    const delay = Math.round(base / 2 + Math.random() * (base / 2))
    this.attempt++
    if (this.attempt === 1 || this.attempt % 10 === 0) this.opts.log.info(`reconnecting in ${delay} ms (attempt ${this.attempt})`)
    this.timer = setTimeout(() => this.connect(), delay)
  }
}
