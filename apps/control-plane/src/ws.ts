// WebSockets on Fastify's HTTP server via 'upgrade':
//   /api/stream  UI fan-out: snapshot on connect, then UiStreamMessages. Local Origin only.
//   /api/runner  agent runners: Authorization: Bearer <agent token>. RunnerMessages in, RunnerCommands out.
//   /api/agents/:id/terminal  interactive shell in the agent's container (./terminal.ts).
//                Admin token + local Origin, checked before the upgrade.

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { parseRunnerMessage, PROTOCOL_VERSION, type UiStreamMessage } from '@colony/shared'
import { sha256, type AgentManager, type RunnerConn } from './agents'
import type { Config } from './config'
import { checkAdmin, isLocalOrigin } from './http'
import type { Store } from './store'
import { toSize, type TerminalHub } from './terminal'

export interface WsDeps {
  config: Config
  store: Store
  agents: AgentManager
  terminals?: TerminalHub
  log?: { info: (m: string) => void; warn: (m: string) => void }
}

const HEARTBEAT_MS = 30_000
const MAX_RUNNER_FRAME = 4 * 1024 * 1024
const TERMINAL_PATH = /^\/api\/agents\/([^/]+)\/terminal$/

function reject(socket: Duplex, status: number, text: string) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } finally {
    socket.destroy()
  }
}

export function attachWebSockets(server: Server, d: WsDeps) {
  const log = d.log ?? { info: (m: string) => console.log(`[ws] ${m}`), warn: (m: string) => console.warn(`[ws] ${m}`) }
  const ui = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  // Terminal sockets join the heartbeat so half-open browser connections get cleaned up.
  d.terminals?.wss.on('connection', (ws: WebSocket) => {
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))
  })
  const runner = new WebSocketServer({ noServer: true, maxPayload: MAX_RUNNER_FRAME })
  const alive = new WeakMap<WebSocket, boolean>()

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://localhost') } catch { return reject(socket, 400, 'Bad Request') }

    if (url.pathname === '/api/stream') {
      if (!isLocalOrigin(req.headers.origin)) return reject(socket, 403, 'Forbidden')
      if (!checkAdmin(d.config, req.headers, url.searchParams.get('token') ?? undefined)) return reject(socket, 401, 'Unauthorized')
      ui.handleUpgrade(req, socket, head, (ws) => ui.emit('connection', ws, req))
      return
    }

    if (url.pathname === '/api/runner') {
      const auth = req.headers.authorization
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
      const rec = token ? d.store.agentByTokenHash(sha256(token)) : undefined
      if (!rec) return reject(socket, 401, 'Unauthorized')
      const agentId = rec.agent.id
      runner.handleUpgrade(req, socket, head, (ws) => runner.emit('connection', ws, req, agentId))
      return
    }

    const term = TERMINAL_PATH.exec(url.pathname)
    if (term && d.terminals) {
      if (!isLocalOrigin(req.headers.origin)) return reject(socket, 403, 'Forbidden')
      if (!checkAdmin(d.config, req.headers, url.searchParams.get('token') ?? undefined)) return reject(socket, 401, 'Unauthorized')
      let agentId: string
      try { agentId = decodeURIComponent(term[1]) } catch { return reject(socket, 400, 'Bad Request') }
      if (!d.store.agents.has(agentId)) return reject(socket, 404, 'Not Found')
      const cols = toSize(url.searchParams.get('cols')) ?? 80
      const rows = toSize(url.searchParams.get('rows')) ?? 24
      d.terminals.handleUpgrade(req, socket, head, agentId, { cols, rows })
      return
    }

    reject(socket, 404, 'Not Found')
  }
  server.on('upgrade', onUpgrade)

  // ── UI stream ──
  ui.on('connection', (ws: WebSocket) => {
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))
    const send = (msg: UiStreamMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)) }
    send({ type: 'snapshot', snapshot: d.store.snapshot(), protocol: PROTOCOL_VERSION })
    const unsubscribe = d.store.subscribe(send)
    ws.on('close', unsubscribe)
    ws.on('error', () => ws.terminate())
    ws.on('message', () => { /* the stream is one-way; commands go over REST */ })
  })

  // ── runners ──
  runner.on('connection', (ws: WebSocket, _req: IncomingMessage, agentId: string) => {
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))
    const conn: RunnerConn = {
      send: (cmd) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd)) },
      close: (code, reason) => { try { ws.close(code, reason) } catch { ws.terminate() } },
    }
    d.agents.onRunnerConnected(agentId, conn)
    log.info(`runner connected: ${agentId}`)
    ws.on('message', (data: RawData) => {
      const parsed = parseRunnerMessage(data.toString())
      if (!parsed.ok) {
        log.warn(`invalid runner message from ${agentId}: ${parsed.error.slice(0, 200)}`)
        return
      }
      try {
        d.agents.handleRunnerMessage(agentId, parsed.value)
      } catch (e) {
        log.warn(`error handling runner message from ${agentId}: ${(e as Error).message}`)
      }
    })
    ws.on('close', () => {
      d.agents.onRunnerDisconnected(agentId, conn)
      log.info(`runner disconnected: ${agentId}`)
    })
    ws.on('error', () => ws.terminate())
  })

  const heartbeat = setInterval(() => {
    for (const wss of [ui, runner, ...(d.terminals ? [d.terminals.wss] : [])]) {
      for (const ws of wss.clients) {
        if (alive.get(ws) === false) { ws.terminate(); continue }
        alive.set(ws, false)
        try { ws.ping() } catch { /* closed */ }
      }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  return {
    ui, runner,
    close() {
      clearInterval(heartbeat)
      server.off('upgrade', onUpgrade)
      for (const ws of ui.clients) ws.close(1001, 'server shutting down')
      for (const ws of runner.clients) ws.close(1012, 'control plane restarting')
      ui.close()
      runner.close()
    },
  }
}
