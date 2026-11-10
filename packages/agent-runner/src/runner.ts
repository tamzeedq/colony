// The runner state machine (docs/phase1.md "Runner behaviour"): owns the control-plane
// connection, the workspace, and one long-lived `claude -p` process, and translates between
// RunnerCommands, the CLI's stream-json, and RunnerMessages.

import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROTOCOL_VERSION,
  createClaudeStreamContext,
  findModel,
  inferAgentStatus,
  mapClaudeStreamLine,
  parseClaudeResult,
  parseRateLimitEvent,
  type AgentStatus,
  type ClaudeStreamContext,
  type RunnerCommand,
  type RunnerMessage,
} from '@colony/shared'
import { ClaudeProcess, buildClaudeArgs, type ClaudeExit } from './claude-process'
import type { RunnerConfig } from './config'
import { ControlConnection } from './connection'
import type { Logger } from './log'
import { turnCost, type CostTracker } from './usage'
import { setupWorkspaceWithRetry, type WorkspaceInfo } from './workspace'

const CRASH_WINDOW_MS = 5 * 60_000
const MAX_CRASHES_IN_WINDOW = 3
const MAX_RESTART_DELAY_MS = 60_000
const SET_MODEL_GRACE_MS = 10_000
const SIGNAL_INTERRUPT_WAIT_MS = 1500
const SIGNAL_GRACE_MS = 3000

/** Per-CLI-process bookkeeping. */
interface ProcState {
  proc: ClaudeProcess
  /** Seen a `system/init` line (the CLI emits one per turn, starting with the first). */
  sawInit: boolean
  /** Messages written before the first init: re-queued if the process dies without starting. */
  unconfirmed: string[]
  /** User messages written that have not produced a `result` yet. */
  pendingTurns: number
  /** Set when we deliberately stop/kill the process, so its exit isn't treated as a crash. */
  expected?: 'stop' | 'interrupt'
  /** Text of a `result` the CLI printed before ever starting (e.g. resume failure). */
  startupError?: string
}

interface PendingInterrupt {
  id: string
  state: ProcState
  timer: NodeJS.Timeout
  resolve: (acked: boolean) => void
}

export interface RunnerOptions {
  log: Logger
  /** Called once the runner has finished shutting down. */
  exit: (code: number) => void
}

export class Runner {
  private readonly cfg: RunnerConfig
  private readonly log: Logger
  private readonly exit: (code: number) => void
  private readonly conn: ControlConnection
  private readonly ctx: ClaudeStreamContext

  private status: AgentStatus | undefined
  private state: ProcState | undefined
  private workspace: WorkspaceInfo | undefined
  private queue: string[] = []
  private paused = false
  private sessionId: string | undefined
  private model: string
  private crashes: number[] = []
  private gaveUp = false
  private restarting = false
  private restartTimer: NodeJS.Timeout | undefined
  private shuttingDown = false
  private interrupt: PendingInterrupt | undefined
  /** The next error `result` belongs to a turn we interrupted: report it as idle, not error. */
  private interruptedTurn = false
  private mcpConfigPath: string | undefined
  private seq = 0
  private cost: CostTracker = { lastTotal: 0 }

  constructor(cfg: RunnerConfig, opts: RunnerOptions) {
    this.cfg = cfg
    this.log = opts.log
    this.exit = opts.exit
    this.model = cfg.model
    this.sessionId = cfg.sessionId
    this.ctx = createClaudeStreamContext({ agentId: cfg.agentId, projectId: cfg.projectId, newId: () => randomUUID() })
    if (cfg.sessionId) { this.ctx.sessionId = cfg.sessionId; this.cost.sessionId = cfg.sessionId }
    this.conn = new ControlConnection({
      url: cfg.controlUrl,
      token: cfg.agentToken,
      log: this.log,
      hello: () => ({ type: 'hello', agentId: cfg.agentId, protocol: PROTOCOL_VERSION, ...(this.sessionId ? { sessionId: this.sessionId } : {}) }),
      // A fresh control-plane process may have lost our state: restate it after reconnecting.
      onReconnect: () => {
        const out: RunnerMessage[] = []
        if (this.workspace) out.push({ type: 'workspace', ...this.workspace })
        if (this.status) out.push({ type: 'status', agentId: cfg.agentId, status: this.status })
        return out
      },
      onCommand: (cmd) => this.handleCommand(cmd),
    })
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.log.info(`agent ${this.cfg.agentId} starting (model ${this.model}${this.sessionId ? `, resume ${this.sessionId}` : ''})`)
    this.conn.start()
    this.setStatus('booting')

    if (this.cfg.mcpConfigJson) {
      this.mcpConfigPath = join(tmpdir(), `colony-mcp-${process.pid}.json`)
      writeFileSync(this.mcpConfigPath, this.cfg.mcpConfigJson, { mode: 0o600 })
    }

    try {
      this.workspace = await setupWorkspaceWithRetry({
        dir: this.cfg.workspace,
        gitUrl: this.cfg.gitUrl,
        branch: this.cfg.branch,
        log: this.log,
        onRetry: (err, attempt) => {
          this.log.warn(`workspace setup failed (attempt ${attempt}); retrying`, err)
          this.send({ type: 'error', message: `workspace setup failed (attempt ${attempt}), retrying: ${err.message}` })
        },
      })
    } catch (e) {
      if (this.shuttingDown) return
      const message = `workspace setup failed: ${(e as Error).message}`
      this.log.error(message)
      this.send({ type: 'error', message, fatal: true })
      this.setStatus('error')
      return // stay connected so the control plane sees the error; `shutdown` still works
    }
    if (this.shuttingDown) return
    this.send({ type: 'workspace', ...this.workspace })
    this.startClaude()
  }

  /** Graceful stop: `shutdown` command (`command`) or SIGTERM/SIGINT (`signal`). */
  async shutdown(source: 'command' | 'signal'): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.log.info(`shutting down (${source})`)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const st = this.state
    this.state = undefined
    if (st?.proc.alive) {
      st.expected = 'stop'
      // Docker gives 10 s between SIGTERM and SIGKILL: interrupt the turn instead of letting it finish.
      if (source === 'signal' && st.pendingTurns > 0) await this.sendInterrupt(st, SIGNAL_INTERRUPT_WAIT_MS)
      const ex = await st.proc.stop(source === 'signal' ? SIGNAL_GRACE_MS : this.cfg.shutdownGraceMs)
      this.log.info(`claude exited (code ${ex.code}, signal ${ex.signal})`)
    }
    this.clearInterrupt(false)
    await this.conn.close(source === 'signal' ? 1000 : 3000)
    if (this.mcpConfigPath) rmSync(this.mcpConfigPath, { force: true })
    this.exit(0)
  }

  // ── commands ───────────────────────────────────────────────────────────────

  handleCommand(cmd: RunnerCommand): void {
    if (this.shuttingDown) { this.log.info(`ignoring ${cmd.type} during shutdown`); return }
    this.log.info(`command: ${cmd.type}`)
    switch (cmd.type) {
      case 'user_message':
        if (this.gaveUp) {
          // A human message after we gave up is an explicit retry.
          this.log.info('user message after crash give-up: restarting claude')
          this.gaveUp = false
          this.crashes = []
          this.queue.push(cmd.text)
          if (this.workspace && !this.state && !this.restarting) this.startClaude()
          return
        }
        if (this.paused || !this.state?.proc.alive || this.restarting) this.queue.push(cmd.text)
        else this.writeUser(this.state, cmd.text)
        return

      case 'interrupt':
        if (this.state) void this.sendInterrupt(this.state, this.cfg.interruptTimeoutMs)
        return

      case 'pause':
        if (this.paused) return
        this.paused = true
        this.setStatus('paused')
        if (this.state) void this.sendInterrupt(this.state, this.cfg.interruptTimeoutMs)
        return

      case 'resume':
        if (this.paused) {
          this.paused = false
          this.setStatus(this.gaveUp ? 'error' : 'idle')
        }
        this.flushQueue()
        return

      case 'set_model': {
        const cli = findModel(cmd.model)?.cliModel ?? cmd.model
        this.log.info(`model ${this.model} → ${cli}`)
        this.model = cli
        if (this.workspace) void this.restartClaude()
        return
      }

      case 'shutdown':
        void this.shutdown('command')
        return
    }
  }

  // ── claude process ─────────────────────────────────────────────────────────

  private startClaude(): void {
    if (this.shuttingDown || this.state) return
    this.restartTimer = undefined
    const args = buildClaudeArgs({
      model: this.model,
      systemPrompt: this.cfg.systemPrompt,
      ...(this.sessionId ? { resume: this.sessionId } : {}),
      ...(this.mcpConfigPath ? { mcpConfigPath: this.mcpConfigPath } : {}),
    })
    const proc = new ClaudeProcess(this.cfg.claudeBin, args, { cwd: this.cfg.workspace, log: this.log })
    const st: ProcState = { proc, sawInit: false, unconfirmed: [], pendingTurns: 0 }
    this.state = st
    this.log.info(`claude started (pid ${proc.pid ?? '?'}, model ${this.model}${this.sessionId ? `, --resume ${this.sessionId}` : ''})`)
    proc.on('line', (line) => this.onLine(st, line))
    proc.on('exit', (ex) => this.onExit(st, ex))
    if (!this.paused) {
      this.setStatus('idle')
      this.flushQueue()
    }
  }

  /** Deliberate restart (set_model): stop the CLI, start it again with --resume. */
  private async restartClaude(): Promise<void> {
    if (this.restarting) return // the pending restart picks up the latest model
    this.restarting = true
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined }
    const st = this.state
    this.state = undefined
    if (st?.proc.alive) {
      st.expected = 'stop'
      if (st.pendingTurns > 0) await this.sendInterrupt(st, 3000)
      await st.proc.stop(SET_MODEL_GRACE_MS)
    }
    this.restarting = false
    this.gaveUp = false
    this.crashes = []
    if (!this.shuttingDown) this.startClaude()
  }

  private writeUser(st: ProcState, text: string): void {
    if (!st.proc.writeUserMessage(text)) { this.queue.unshift(text); return }
    st.pendingTurns++
    if (!st.sawInit) st.unconfirmed.push(text)
  }

  private flushQueue(): void {
    const st = this.state
    while (this.queue.length && st?.proc.alive && !this.paused && !this.restarting) {
      this.writeUser(st, this.queue.shift()!)
    }
  }

  /** Send the stream-json interrupt control request; SIGINT if it isn't acknowledged in time. */
  private sendInterrupt(st: ProcState, timeoutMs: number): Promise<boolean> {
    if (!st.proc.alive || st.pendingTurns === 0) return Promise.resolve(false)
    if (this.interrupt?.state === st) return new Promise((r) => {
      const prev = this.interrupt!.resolve
      this.interrupt!.resolve = (a) => { prev(a); r(a) }
    })
    const id = `interrupt-${++this.seq}-${randomUUID().slice(0, 8)}`
    this.interruptedTurn = true
    st.proc.write({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.interrupt?.id !== id) return
        this.log.warn(`no control_response to interrupt after ${timeoutMs} ms; sending SIGINT`)
        this.clearInterrupt(false)
        if (!st.expected) st.expected = 'interrupt'
        st.proc.kill('SIGINT')
      }, timeoutMs)
      this.interrupt = { id, state: st, timer, resolve }
    })
  }

  private clearInterrupt(acked: boolean): void {
    const p = this.interrupt
    if (!p) return
    this.interrupt = undefined
    clearTimeout(p.timer)
    p.resolve(acked)
  }

  private onLine(st: ProcState, line: string): void {
    let msg: Record<string, any>
    try {
      msg = JSON.parse(line)
    } catch {
      this.log.warn(`non-JSON stdout from claude: ${line.slice(0, 300)}`)
      return
    }
    if (typeof msg !== 'object' || msg === null) return

    switch (msg.type) {
      case 'control_response': {
        const id = msg.response?.request_id
        if (this.interrupt && id === this.interrupt.id) {
          if (msg.response?.subtype === 'success') {
            this.log.info('interrupt acknowledged by claude')
            this.clearInterrupt(true)
          } else {
            this.log.warn('interrupt control request rejected; sending SIGINT', msg.response?.error)
            this.clearInterrupt(false)
            if (!st.expected) st.expected = 'interrupt'
            st.proc.kill('SIGINT')
          }
        }
        return
      }
      case 'control_request':
        this.log.warn(`ignoring control_request from claude: ${msg.request?.subtype ?? '?'}`)
        return
      case 'rate_limit_event': {
        const usage = parseRateLimitEvent(msg)
        if (usage) this.send({ type: 'plan_usage', usage })
        return
      }
      case 'system':
        if (msg.subtype === 'init') { st.sawInit = true; st.unconfirmed = [] }
        break
      case 'result':
        if (!st.sawInit) {
          // The CLI failed before starting a turn (e.g. --resume of an unknown session).
          st.startupError = typeof msg.result === 'string' ? msg.result : (Array.isArray(msg.errors) ? msg.errors.join('; ') : msg.subtype)
          this.log.warn(`claude reported a startup failure: ${String(st.startupError).slice(0, 300)}`)
          return
        }
        break
    }

    const events = mapClaudeStreamLine(msg, this.ctx)
    const result = msg.type === 'result' ? parseClaudeResult(msg) : undefined

    if (result) {
      st.pendingTurns = typeof msg.queued_turn_count === 'number' ? msg.queued_turn_count : Math.max(0, st.pendingTurns - 1)
      if (this.interruptedTurn) {
        this.interruptedTurn = false
        if (result.isError) {
          for (const ev of events) {
            if (ev.kind === 'status') { ev.status = this.paused ? 'paused' : 'idle'; ev.text = ev.text.replace(/^Turn failed \([^)]*\)/, 'Interrupted') }
          }
        }
      }
    }

    for (const ev of events) {
      this.send({ type: 'event', event: ev })
      const s = inferAgentStatus(ev)
      if (s && !this.paused) this.setStatus(s)
    }

    if (this.ctx.sessionId && this.ctx.sessionId !== this.sessionId) {
      this.sessionId = this.ctx.sessionId
      this.log.info(`session id ${this.sessionId}`)
    }

    if (result) {
      const r: RunnerMessage = {
        type: 'result',
        subtype: result.subtype,
        isError: result.isError,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.text !== undefined ? { text: result.text } : {}),
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
        ...(result.numTurns !== undefined ? { numTurns: result.numTurns } : {}),
        ...(result.totalCostUsd !== undefined ? { totalCostUsd: result.totalCostUsd } : {}),
      }
      this.send(r)
      const costUsd = turnCost(msg, this.cost)
      this.send({ type: 'usage', ...result.usage, ...(costUsd !== undefined ? { costUsd } : {}) })
    }
  }

  private onExit(st: ProcState, ex: ClaudeExit): void {
    if (this.interrupt?.state === st) this.clearInterrupt(false)
    this.closeOpenTools()
    if (this.state === st) this.state = undefined
    if (this.shuttingDown || st.expected === 'stop') return

    if (st.unconfirmed.length) this.queue.unshift(...st.unconfirmed)

    if (st.expected === 'interrupt') {
      // SIGINT fallback ended the process: carry on in the same session.
      this.log.info('claude exited after SIGINT interrupt; restarting with --resume')
      if (!this.paused) this.setStatus('idle')
      this.startClaude()
      return
    }

    const detail = ex.error ? ex.error.message : `code ${ex.code}${ex.signal ? `, signal ${ex.signal}` : ''}`
    const why = [st.startupError, st.proc.stderrTail.trim().split('\n').slice(-5).join(' | ')].filter(Boolean).join(' | ').slice(-800)

    if (this.sessionId && /No conversation found with session ID/i.test(`${st.proc.stderrTail}\n${st.startupError ?? ''}`)) {
      this.log.warn(`session ${this.sessionId} not found; starting a fresh session`)
      this.send({ type: 'error', message: `claude session ${this.sessionId} not found in this container; started a new session` })
      this.sessionId = undefined
      this.ctx.sessionId = undefined
      this.startClaude()
      return
    }

    const now = Date.now()
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS)
    this.crashes.push(now)
    const message = `claude exited unexpectedly (${detail})${why ? `: ${why}` : ''}`
    this.log.error(message)

    if (this.crashes.length >= MAX_CRASHES_IN_WINDOW) {
      this.gaveUp = true
      this.send({ type: 'error', message: `${message}; ${this.crashes.length} crashes in 5 minutes, not restarting`, fatal: true })
      this.setStatus('error')
      return
    }
    this.send({ type: 'error', message })
    if (!this.paused) this.setStatus('booting')
    const delay = Math.min(MAX_RESTART_DELAY_MS, this.cfg.restartBaseMs * 4 ** (this.crashes.length - 1))
    this.log.info(`restarting claude in ${delay} ms`)
    this.restartTimer = setTimeout(() => this.startClaude(), delay)
  }

  /** A dead process never reports its open tool calls: mark running commands as stopped. */
  private closeOpenTools(): void {
    const at = new Date().toISOString()
    for (const { event } of this.ctx.pending.values()) {
      if (event.kind === 'command' && event.command?.running) {
        this.send({ type: 'event', event: { ...event, at, text: `${event.text} (stopped)`, command: { ...event.command, running: false } } })
      }
    }
    this.ctx.pending.clear()
  }

  // ── outgoing ───────────────────────────────────────────────────────────────

  private setStatus(status: AgentStatus): void {
    if (status === this.status) return
    this.status = status
    this.send({ type: 'status', agentId: this.cfg.agentId, status })
  }

  private send(msg: RunnerMessage): void {
    this.conn.send(msg)
  }
}
