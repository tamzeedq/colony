// Interactive terminals into agent containers (docs/phase2.md, protocol from spikes/03-pty):
//   WS /api/agents/:id/terminal?token=&cols=&rows=
//   client → server  binary: terminal input · text: JSON {type:'resize', cols, rows}
//   server → client  binary: raw PTY output
// Each socket gets its own `bash -l` (as node, in /workspace) via InfraDriver.openShell, killed
// when the socket closes. Auth, Origin and agent existence are checked in ws.ts before the
// upgrade.
//
// Close codes: 1000 shell exited · 1001 server shutting down · 1011 could not open the shell ·
// 4000 idle timeout · 4008 too many terminals for this agent · 4009 container not running.

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { Config } from './config'
import type { InfraDriver, ShellHandle } from './infra/types'
import { newId, nowIso, type Store } from './store'

type Log = { info: (m: string) => void; warn: (m: string) => void }

export const TERMINAL_CLOSE = {
  shellExited: 1000,
  shuttingDown: 1001,
  openFailed: 1011,
  idle: 4000,
  tooMany: 4008,
  notRunning: 4009,
} as const

const HIGH_WATER = 1024 * 1024        // pause the PTY when this much output is waiting for the socket
const LOW_WATER = 256 * 1024
const MAX_PENDING_INPUT = 64 * 1024   // input received before the shell is ready

interface Session {
  agentId: string
  close(code: number, reason: string): void
  done: Promise<void>
}

export class TerminalHub {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  private sessions = new Map<string, Set<Session>>()

  constructor(private config: Config, private store: Store, private infra: InfraDriver, private log: Log) {}

  /** Number of open (or opening) terminals for an agent. */
  count(agentId: string) { return this.sessions.get(agentId)?.size ?? 0 }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, agentId: string, size: { cols: number; rows: number }) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req)
      this.accept(ws, agentId, size)
    })
  }

  private accept(ws: WebSocket, agentId: string, size: { cols: number; rows: number }) {
    const max = this.config.maxTerminalsPerAgent
    let set = this.sessions.get(agentId)
    if (!set) this.sessions.set(agentId, (set = new Set()))
    if (set.size >= max) {
      ws.close(TERMINAL_CLOSE.tooMany, `too many terminals for this agent (max ${max})`)
      return
    }

    let handle: ShellHandle | undefined
    let closed = false
    let opened = false
    let paused = false
    let idleTimer: NodeJS.Timeout | undefined
    let pendingBytes = 0
    const pending: Buffer[] = []
    const openedAt = Date.now()
    let resolveDone!: () => void
    const done = new Promise<void>((r) => { resolveDone = r })

    const session: Session = {
      agentId,
      done,
      close: (code, reason) => cleanup(code, reason),
    }
    set.add(session)

    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => cleanup(TERMINAL_CLOSE.idle, 'idle timeout'), this.config.terminalIdleMs)
      idleTimer.unref?.()
    }

    const cleanup = (code: number, reason: string) => {
      if (closed) return
      closed = true
      if (idleTimer) clearTimeout(idleTimer)
      set!.delete(session)
      if (set!.size === 0) this.sessions.delete(agentId)
      if (opened) this.event(agentId, 'Terminal closed', `${reason} · open ${fmtDuration(Date.now() - openedAt)}`)
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(code, reason.slice(0, 120)) } catch { ws.terminate() }
      }
      const kill = handle ? handle.kill().catch((e) => this.log.warn(`terminal kill for ${agentId} failed: ${(e as Error).message}`)) : Promise.resolve()
      void kill.finally(resolveDone)
    }

    ws.on('close', () => cleanup(TERMINAL_CLOSE.shellExited, 'client disconnected'))
    ws.on('error', () => { cleanup(TERMINAL_CLOSE.openFailed, 'socket error'); ws.terminate() })
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = toBuffer(data)
      if (!isBinary) {
        let msg: unknown = null
        try { msg = JSON.parse(buf.toString('utf8')) } catch { /* plain text: treat as input */ }
        if (msg && typeof msg === 'object' && typeof (msg as { type?: unknown }).type === 'string') {
          const m = msg as { type: string; cols?: unknown; rows?: unknown }
          if (m.type === 'resize' && handle) {
            const cols = toSize(m.cols), rows = toSize(m.rows)
            if (cols && rows) handle.resize(cols, rows).catch((e) => this.log.warn(`terminal resize failed: ${(e as Error).message}`))
          }
          return
        }
      }
      touch()
      if (handle) handle.stream.write(buf)
      else if (pendingBytes + buf.length <= MAX_PENDING_INPUT) { pending.push(buf); pendingBytes += buf.length }
    })

    touch()
    const open = this.infra.openShell?.bind(this.infra)
    if (!open) {
      cleanup(TERMINAL_CLOSE.openFailed, 'terminals are not supported by this infrastructure driver')
      return
    }
    open(agentId, size).then((h) => {
      handle = h
      if (closed) { void h.kill().catch(() => {}).finally(resolveDone); return }
      opened = true
      this.event(agentId, 'Terminal opened')
      const stream = h.stream
      stream.on('data', (chunk: Buffer) => {
        if (ws.readyState !== WebSocket.OPEN) return
        touch()
        ws.send(chunk, { binary: true }, () => {
          if (paused && ws.bufferedAmount < LOW_WATER) { paused = false; stream.resume() }
        })
        if (!paused && ws.bufferedAmount > HIGH_WATER) { paused = true; stream.pause() }
      })
      stream.on('end', () => cleanup(TERMINAL_CLOSE.shellExited, 'shell exited'))
      stream.on('close', () => cleanup(TERMINAL_CLOSE.shellExited, 'shell exited'))
      stream.on('error', (e: Error) => cleanup(TERMINAL_CLOSE.openFailed, `shell stream error: ${e.message}`))
      for (const b of pending.splice(0)) stream.write(b)
    }, (e: Error) => {
      const notRunning = e?.name === 'ContainerNotRunningError'
      if (!notRunning) this.log.warn(`terminal for ${agentId} failed to open: ${e?.message}`)
      cleanup(notRunning ? TERMINAL_CLOSE.notRunning : TERMINAL_CLOSE.openFailed, notRunning ? 'agent container is not running' : 'could not open a shell')
    })
  }

  private event(agentId: string, text: string, detail?: string) {
    const rec = this.store.agents.get(agentId)
    if (!rec) return
    this.store.addEvent({
      id: newId('ev'), at: nowIso(), agentId, projectId: rec.agent.projectId, kind: 'status', text,
      tool: { name: 'terminal', ...(detail ? { target: detail } : {}) },
    })
  }

  /** Close every terminal (killing its shell) and wait briefly for the kills to be sent. */
  async close() {
    const all = [...this.sessions.values()].flatMap((s) => [...s])
    for (const s of all) s.close(TERMINAL_CLOSE.shuttingDown, 'server shutting down')
    await Promise.race([Promise.allSettled(all.map((s) => s.done)), new Promise((r) => setTimeout(r, 3000).unref?.())])
    this.wss.close()
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data as ArrayBuffer)
}

export function toSize(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000 ? n : undefined
}

function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
