// Runner WebSocket protocol: connection bookkeeping, the grace timers that turn a silent runner
// into a crash alert, and handling of the runner's messages (hello/status/usage/event/...).
// Lifecycle (spawn/restart/kill/pause/resume) stays in AgentManager (../agents.ts).

import type { ActivityEvent, PlanUsage, RunnerCommand, RunnerMessage } from '@colony/shared'
import type { AgentHooks } from '../agents'
import type { Config } from '../config'
import { newId, nowIso, type Store } from '../store'

export interface RunnerConn {
  send(cmd: RunnerCommand): void
  close(code?: number, reason?: string): void
}

type Log = { info: (m: string) => void; warn: (m: string) => void }

export class RunnerLinks {
  private conns = new Map<string, RunnerConn>()
  private timers = new Map<string, NodeJS.Timeout>()
  private rateBase: { usedPct: number; at: number; resetsAt: string } | undefined

  constructor(
    private store: Store,
    private config: Config,
    private hooks: () => AgentHooks,
    private log: Log,
  ) {}

  isConnected(id: string) { return this.conns.has(id) }

  /** Called by the runner hub once the Bearer token resolved to this agent. */
  onConnected(agentId: string, conn: RunnerConn) {
    const old = this.conns.get(agentId)
    if (old && old !== conn) old.close(4000, 'replaced by a new connection')
    this.conns.set(agentId, conn)
    this.store.connected.add(agentId)
    this.clearTimer(agentId)
  }

  onDisconnected(agentId: string, conn: RunnerConn) {
    if (this.conns.get(agentId) !== conn) return
    this.conns.delete(agentId)
    this.store.connected.delete(agentId)
    if (this.store.agents.has(agentId)) this.armTimer(agentId, this.config.runnerGraceMs, 'runner disconnected')
  }

  /** Expect a runner to (re)connect within the grace period (used by reconcile on boot). */
  expectReconnect(agentId: string) {
    if (!this.conns.has(agentId)) this.armTimer(agentId, this.config.runnerGraceMs, 'runner did not reconnect')
  }

  /** Close and forget an agent's connection; `untrack` also clears the store's connected flag. */
  drop(agentId: string, code: number, reason: string, untrack = false) {
    this.conns.get(agentId)?.close(code, reason)
    this.conns.delete(agentId)
    if (untrack) this.store.connected.delete(agentId)
  }

  armTimer(agentId: string, ms: number, reason: string) {
    this.clearTimer(agentId)
    const t = setTimeout(() => {
      this.timers.delete(agentId)
      const rec = this.store.agents.get(agentId)
      if (!rec || this.conns.has(agentId) || rec.agent.status === 'error' || rec.agent.status === 'done') return
      this.store.patchAgent(agentId, { status: 'error', currentAction: `Lost contact: ${reason}`, container: { ...rec.agent.container, health: 'degraded' } })
      this.hooks().afterCrash?.(rec.agent, `lost contact (${reason})`)
      this.store.raiseAlert({
        kind: 'crash', severity: 'critical', projectId: rec.agent.projectId, agentId,
        title: `${rec.agent.callsign} lost contact (${reason})`,
        actions: [{ id: 'restart', label: '↻ Restart', primary: true }],
      })
    }, ms)
    t.unref?.()
    this.timers.set(agentId, t)
  }
  clearTimer(agentId: string) {
    const t = this.timers.get(agentId)
    if (t) clearTimeout(t)
    this.timers.delete(agentId)
  }

  /** Send a command to the agent's runner. Returns false if it is not connected. */
  send(agentId: string, cmd: RunnerCommand): boolean {
    const c = this.conns.get(agentId)
    if (!c) return false
    c.send(cmd)
    return true
  }

  handleMessage(agentId: string, msg: RunnerMessage) {
    const rec = this.store.agents.get(agentId)
    if (!rec) return
    rec.internal.lastSeenAt = nowIso()
    switch (msg.type) {
      case 'hello': {
        if (msg.agentId !== agentId) {
          this.log.warn(`hello for ${msg.agentId} on ${agentId}'s token; closing`)
          this.conns.get(agentId)?.close(4003, 'agent id does not match token')
          return
        }
        if (msg.sessionId) rec.sessionId = msg.sessionId
        const paused = rec.internal.desired === 'paused'
        // A booting/errored agent stays 'booting' on hello: the runner reports its own status
        // right after (booting → idle once Claude Code is up), so jumping to idle here flickers.
        const status = paused ? 'paused' : (rec.agent.status === 'booting' || rec.agent.status === 'error' ? 'booting' : rec.agent.status)
        const wasBooting = rec.agent.status === 'booting' || rec.agent.status === 'error'
        this.store.patchAgent(agentId, { status, ...(paused ? { currentAction: 'Paused' } : wasBooting ? { currentAction: '' } : {}), container: { ...rec.agent.container, health: 'ok' } })
        if (paused) this.send(agentId, { type: 'pause' })
        const pending = rec.internal.pending
        if (pending.length) {
          for (const text of pending) this.send(agentId, { type: 'user_message', text })
          this.store.patchAgent(agentId, {}, { pending: [] })
        }
        return
      }
      case 'event': {
        // Stored redacted (redact.ts): use what was stored for the card and the hooks too.
        const ev = this.store.addEvent({ ...msg.event, agentId, projectId: rec.agent.projectId })
        const action = actionFor(ev)
        if (action && action !== rec.agent.currentAction) this.store.patchAgent(agentId, { currentAction: action })
        this.hooks().afterEvent?.(ev)
        return
      }
      case 'status':
        if (msg.status !== rec.agent.status) {
          const reportedPause = msg.status === 'paused' && rec.internal.desired === 'paused'
          this.store.patchAgent(agentId, { status: msg.status, ...(reportedPause ? { currentAction: rec.internal.pausedBy && rec.internal.pausedBy !== 'you' ? `Paused (${rec.internal.pausedBy.replace('_', ' ')})` : 'Paused by you' } : {}) })
        }
        return
      case 'usage': {
        const tokens = msg.inputTokens + msg.outputTokens
        this.store.addUsage(agentId, msg.costUsd ?? 0, tokens)
        this.hooks().afterUsage?.(agentId)
        return
      }
      case 'result':
        if (msg.sessionId && msg.sessionId !== rec.sessionId) { rec.sessionId = msg.sessionId; this.store.saveAgent(rec) }
        return
      case 'plan_usage':
        this.store.setPlanUsage(this.withRate(msg.usage), agentId)
        this.hooks().afterPlanUsage?.()
        return
      case 'workspace':
        if (msg.branch !== rec.agent.branch) this.store.patchAgent(agentId, { branch: msg.branch })
        return
      case 'error': {
        this.store.addEvent({
          id: newId('ev'), at: nowIso(), agentId, projectId: rec.agent.projectId, kind: 'status',
          text: `${msg.fatal ? 'Fatal error' : 'Error'}: ${msg.message}`, ...(msg.fatal ? { status: 'error' as const } : {}),
        })
        if (msg.fatal) {
          this.store.patchAgent(agentId, { status: 'error', currentAction: `Crashed: ${msg.message.slice(0, 120)}` })
          this.store.raiseAlert({
            kind: 'crash', severity: 'critical', projectId: rec.agent.projectId, agentId,
            title: `${rec.agent.callsign} crashed`, detail: msg.message,
            actions: [{ id: 'restart', label: '↻ Restart', primary: true }],
          })
          this.hooks().afterCrash?.(rec.agent, `crashed: ${msg.message.slice(0, 300)}`)
        }
        return
      }
    }
  }

  /** Fill ratePctPerHour from successive snapshots (or the average since the window began). */
  private withRate(u: PlanUsage): PlanUsage {
    const prev = this.store.usage
    const at = Date.parse(u.syncedAt) || Date.now()
    let rate = prev.source === 'connected' && prev.session.resetsAt === u.session.resetsAt ? prev.session.ratePctPerHour : 0
    const base = this.rateBase
    if (!base || base.resetsAt !== u.session.resetsAt) {
      this.rateBase = { usedPct: u.session.usedPct, at, resetsAt: u.session.resetsAt }
      const windowStart = Date.parse(u.session.resetsAt) - 5 * 3600_000
      const hours = (at - windowStart) / 3600_000
      if (hours > 0.05 && hours <= 5) rate = u.session.usedPct / hours
    } else {
      const hours = (at - base.at) / 3600_000
      if (hours >= 10 / 60) {
        rate = Math.max(0, (u.session.usedPct - base.usedPct) / hours)
        this.rateBase = { usedPct: u.session.usedPct, at, resetsAt: u.session.resetsAt }
      }
    }
    return { ...u, session: { ...u.session, ratePctPerHour: Math.round(rate * 10) / 10 } }
  }

  /** Close all runner sockets (graceful shutdown; runners reconnect to the next instance). */
  closeAll() {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const c of this.conns.values()) c.close(1012, 'control plane restarting')
    this.conns.clear()
  }
}

function actionFor(ev: ActivityEvent): string | undefined {
  switch (ev.kind) {
    case 'command': return ev.command?.cmd ?? ev.text
    case 'test': return ev.text
    case 'edit': return ev.edit?.path ?? ev.text
    case 'tool': return ev.text
    case 'thought': return ev.text.length > 80 ? ev.text.slice(0, 77) + '…' : ev.text
    default: return undefined
  }
}
