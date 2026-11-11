// The UI stream: one WebSocket per window to `/api/stream?token=…` carrying UiStreamMessages
// (snapshot on connect, then agent_delta / event / alert / resources). Reconnects with
// exponential backoff and reports its connection state.
//
// A browser can't see the HTTP status of a rejected upgrade, so when a connection fails
// before opening we probe one authenticated REST call: a 401 there clears the token (client.ts).
import type { UiStreamMessage } from '@/types/colony'
import { parseUiStreamMessage } from '@/types/colony'
import { api, ApiError, wsUrl } from './client'

export type StreamState = 'connecting' | 'open' | 'reconnecting'

export interface StreamInfo { state: StreamState; attempt: number; retryAt?: number; lastError?: string }

export interface StreamHandle { close(): void; retryNow(): void }

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000]

export function connectStream(opts: {
  token: string
  onMessage: (msg: UiStreamMessage, raw: Record<string, unknown>) => void
  onInfo: (info: StreamInfo) => void
}): StreamHandle {
  let ws: WebSocket | null = null
  let closed = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const open = () => {
    clearTimeout(timer)
    if (closed) return
    opts.onInfo({ state: attempt === 0 ? 'connecting' : 'reconnecting', attempt })
    let opened = false
    const sock = new WebSocket(wsUrl('/api/stream', { token: opts.token }))
    ws = sock
    sock.onopen = () => { opened = true; attempt = 0; opts.onInfo({ state: 'open', attempt: 0 }) }
    sock.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let raw: Record<string, unknown>
      try { raw = JSON.parse(ev.data) } catch { return }
      const parsed = parseUiStreamMessage(raw)
      if (parsed.ok) { opts.onMessage(parsed.value, raw); return }
      console.warn('[colony] bad stream message', parsed.error.slice(0, 300))
      // The control plane is trusted; don't drop a whole snapshot over one odd backlog event.
      if (raw.type === 'snapshot' && raw.snapshot && typeof raw.snapshot === 'object') opts.onMessage(raw as unknown as UiStreamMessage, raw)
    }
    sock.onclose = async (ev) => {
      if (ws !== sock) return
      ws = null
      if (closed) return
      let lastError = ev.reason || (opened ? 'connection lost' : "can't connect")
      if (!opened) {
        // Was it the token? A 401 here clears it and the app shows Pair (we stop retrying via close()).
        try { await api('GET', '/api/snapshot') } catch (e) {
          if (e instanceof ApiError) { if (e.status === 401) return; lastError = e.message }
        }
      }
      if (closed) return
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
      attempt++
      opts.onInfo({ state: 'reconnecting', attempt, retryAt: Date.now() + delay, lastError })
      timer = setTimeout(open, delay)
    }
  }

  open()
  return {
    close() { closed = true; clearTimeout(timer); const s = ws; ws = null; s?.close(1000, 'bye') },
    retryNow() { if (!ws && !closed) open() },
  }
}
