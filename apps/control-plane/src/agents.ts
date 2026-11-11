// Agent lifecycle: spawn, runner protocol handling, and commander commands.
//
// The agent token is generated here, handed to the container as COLONY_AGENT_TOKEN, and only
// its sha256 is stored. A restart rotates it (we cannot recover the old one).

import { createHash, randomBytes } from 'node:crypto'
import {
  findModel, ROLE_IDS,
  type ActivityEvent, type Agent, type ModelId, type PlanUsage, type RoleId, type RunnerCommand, type RunnerMessage,
} from '@colony/shared'
import type { Config } from './config'
import { badRequest, conflict, HttpError, infraError, notFound, upstream } from './errors'
import type { InfraDriver } from './infra/types'
import type { RoleLibrary } from './roles'
import { newId, nowIso, type AgentRecord, type Store } from './store'

export interface RunnerConn {
  send(cmd: RunnerCommand): void
  close(code?: number, reason?: string): void
}

export interface SpawnInput {
  role: RoleId
  model?: ModelId
  callsign?: string
  task?: string
  budgetCapUsd?: number
  /** Custom roles: the commander's text standing in for <role>.md. */
  rolePrompt?: string
}

export interface PatchInput {
  model?: ModelId
  rolePrompt?: string
  budgetCapUsd?: number
}

export interface AgentHooks {
  afterUsage?(agentId: string): void
  afterPlanUsage?(): void
  /** Every activity event from a runner (loop detection). */
  afterEvent?(ev: ActivityEvent): void
  /** An agent was removed (its quests go back to the backlog). */
  afterRemove?(agent: Agent): void
  /** An agent crashed or lost contact. */
  afterCrash?(agent: Agent, reason: string): void
}

const CALLSIGN_WORDS = [
  'Vex', 'Mira', 'Kip', 'Rho', 'Juno', 'Atlas', 'Sable', 'Tern', 'Lux', 'Pike', 'Onyx', 'Wren', 'Ash', 'Dot',
  'Bram', 'Quill', 'Nyx', 'Orrin', 'Cove', 'Fen', 'Hale', 'Ivo', 'Jett', 'Koa', 'Lark', 'Moss', 'Nova', 'Opal',
  'Pax', 'Rook', 'Sol', 'Tak', 'Umber', 'Vale', 'Wick', 'Yara', 'Zed', 'Cinder', 'Drift', 'Ember', 'Flint', 'Grit',
]

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const CALLSIGN_RE = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{2}$/
const DEFAULT_MODEL: Record<string, ModelId> = { orchestrator: 'opus-5.5' }
const BOOT_TIMEOUT_FACTOR = 6 // boot timeout = 6 × runner grace (3 min by default)

type Log = { info: (m: string) => void; warn: (m: string) => void }

export class AgentManager {
  private conns = new Map<string, RunnerConn>()
  private timers = new Map<string, NodeJS.Timeout>()
  private rateBase: { usedPct: number; at: number; resetsAt: string } | undefined
  hooks: AgentHooks = {}

  constructor(
    private store: Store,
    private infra: InfraDriver,
    private config: Config,
    private roles: RoleLibrary,
    private log: Log = { info: (m) => console.log(`[agents] ${m}`), warn: (m) => console.warn(`[agents] ${m}`) },
  ) {}

  isConnected(id: string) { return this.conns.has(id) }

  get(id: string): AgentRecord {
    const rec = this.store.agents.get(id)
    if (!rec) throw notFound('agent')
    return rec
  }

  generateCallsign(): string {
    for (let i = 0; i < 500; i++) {
      const w = CALLSIGN_WORDS[randomBytes(1)[0] % CALLSIGN_WORDS.length]
      const c = `${w}-${String(randomBytes(1)[0] % 100).padStart(2, '0')}`
      if (!this.store.callsignTaken(c)) return c
    }
    throw conflict('could not generate a free callsign')
  }

  liveAgentCount() {
    return [...this.store.agents.values()].filter((a) => a.agent.status !== 'error' && a.agent.status !== 'done').length
  }

  // ── spawn ──────────────────────────────────────────────────────────────────

  async spawn(projectId: string, input: SpawnInput): Promise<Agent> {
    const prec = this.store.projects.get(projectId)
    if (!prec) throw notFound('project')
    if (!(ROLE_IDS as readonly string[]).includes(input.role)) throw badRequest(`unknown role '${input.role}'`)
    const modelId = input.model ?? DEFAULT_MODEL[input.role] ?? 'sonnet-5.5'
    const model = findModel(modelId)
    if (!model) throw badRequest(`unknown model '${modelId}'`)
    if (!this.config.oauthToken) throw new HttpError(412, 'missing_token', 'CLAUDE_CODE_OAUTH_TOKEN is not configured (set it in .env)')
    if (input.role === 'orchestrator' && this.store.projectAgents(projectId).some((a) => a.agent.role === 'orchestrator')) {
      throw conflict('this project already has an orchestrator')
    }
    if (this.liveAgentCount() >= this.config.maxContainers) throw conflict(`container limit reached (${this.config.maxContainers})`)
    const inProject = this.store.projectAgents(projectId).filter((a) => a.agent.status !== 'error' && a.agent.status !== 'done').length
    if (inProject >= this.config.maxAgentsPerProject) throw conflict(`this base already has ${inProject} agents (limit ${this.config.maxAgentsPerProject}); stop one first`)

    let callsign = input.callsign?.trim()
    if (callsign) {
      if (!CALLSIGN_RE.test(callsign)) throw badRequest('callsign must look like "Vex-07"')
      callsign = callsign[0].toUpperCase() + callsign.slice(1)
      if (this.store.callsignTaken(callsign)) throw conflict(`callsign ${callsign} is taken`)
    } else callsign = this.generateCallsign()

    const lower = callsign.toLowerCase()
    const id = `${lower}-${randomBytes(3).toString('hex')}`
    const p = prec.project
    const orchestrator = this.store.projectAgents(projectId).find((a) => a.agent.role === 'orchestrator')?.agent.callsign
    const rolePrompt = this.roles.compose(input.role, { project: p.name, stack: p.stack, goal: p.goal, orchestrator }, input.rolePrompt)
    const budget = input.budgetCapUsd ?? this.config.defaultBudgetCapUsd
    const task = input.task?.trim() || (input.role === 'orchestrator' && p.goal.trim() ? kickoff(p.goal) : '')
    const t = nowIso()
    const agent: Agent = {
      id, projectId, callsign, role: input.role, provider: model.provider, model: model.id,
      status: 'booting', controller: 'agent', branch: `agent/${lower}`,
      container: { name: `colony-agent-${id}`, cpuPct: 0, memMb: 0, memLimitMb: this.config.agentMemoryMb, health: 'ok' },
      contextPct: 0, tokensToday: 0, spendTodayUsd: 0, budgetCapUsd: budget, sessionShare: 0, uptimeSec: 0,
      level: 1, xp: 0, questsDone: 0, rolePrompt, allowedTools: ['read', 'edit', 'bash'],
      currentAction: 'Booting container',
    }
    const token = randomBytes(32).toString('base64url')
    const rec: AgentRecord = {
      agent, tokenHash: sha256(token), createdAt: t,
      internal: { desired: 'run', pending: task ? [task] : [], startedAt: t },
    }
    this.store.saveAgent(rec)
    this.store.broadcastSnapshot()
    await this.startContainer(rec, token)
    return this.store.toAgent(this.get(id))
  }

  /** Environment for the agent container (docs/phase1.md "Agent container environment"). */
  buildEnv(rec: AgentRecord, token: string): Record<string, string> {
    const a = rec.agent
    const model = findModel(a.model)
    const env: Record<string, string> = {
      COLONY_AGENT_ID: a.id,
      COLONY_PROJECT_ID: a.projectId,
      COLONY_CONTROL_URL: this.config.publicRunnerUrl,
      COLONY_AGENT_TOKEN: token,
      COLONY_GIT_URL: this.config.gitUrl,
      COLONY_BRANCH: a.branch ?? `agent/${a.callsign.toLowerCase()}`,
      COLONY_MODEL: model?.cliModel ?? a.model,
      COLONY_SYSTEM_PROMPT_B64: Buffer.from(a.rolePrompt, 'utf8').toString('base64'),
    }
    // Colony's MCP tools (docs/phase3.md), authenticated with the same per-agent token.
    const mcp = { mcpServers: { colony: { type: 'http', url: this.config.publicMcpUrl, headers: { Authorization: `Bearer ${token}` } } } }
    env.COLONY_MCP_CONFIG_B64 = Buffer.from(JSON.stringify(mcp), 'utf8').toString('base64')
    if (rec.sessionId) env.COLONY_SESSION_ID = rec.sessionId
    if (this.config.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.config.oauthToken
    return env
  }

  private async startContainer(rec: AgentRecord, token: string) {
    const prec = this.store.projects.get(rec.agent.projectId)
    if (!prec) throw notFound('project')
    const id = rec.agent.id
    try {
      const { name } = await this.infra.startAgent({
        agentId: id, projectSlug: prec.slug, image: this.config.agentImage, env: this.buildEnv(rec, token),
        memoryMb: this.config.agentMemoryMb, cpus: this.config.agentCpus,
      })
      this.store.patchAgent(id, { container: { ...this.get(id).agent.container, name, health: 'ok' } }, { startedAt: nowIso() })
      this.armTimer(id, this.config.runnerGraceMs * BOOT_TIMEOUT_FACTOR, 'never connected after start')
    } catch (e) {
      const msg = (e as Error).message
      this.store.patchAgent(id, { status: 'error', currentAction: `Failed to start: ${msg}`, container: { ...this.get(id).agent.container, health: 'down' } })
      this.store.raiseAlert({
        kind: 'crash', severity: 'critical', projectId: rec.agent.projectId, agentId: id,
        title: `${rec.agent.callsign} failed to start`, detail: msg,
        actions: [{ id: 'restart', label: '↻ Restart', primary: true }],
      })
      throw upstream(`failed to start agent container: ${msg}`)
    }
  }

  // ── runner connection ───────────────────────────────────────────────────────

  /** Called by the runner hub once the Bearer token resolved to this agent. */
  onRunnerConnected(agentId: string, conn: RunnerConn) {
    const old = this.conns.get(agentId)
    if (old && old !== conn) old.close(4000, 'replaced by a new connection')
    this.conns.set(agentId, conn)
    this.store.connected.add(agentId)
    this.clearTimer(agentId)
  }

  onRunnerDisconnected(agentId: string, conn: RunnerConn) {
    if (this.conns.get(agentId) !== conn) return
    this.conns.delete(agentId)
    this.store.connected.delete(agentId)
    if (this.store.agents.has(agentId)) this.armTimer(agentId, this.config.runnerGraceMs, 'runner disconnected')
  }

  /** Expect a runner to (re)connect within the grace period (used by reconcile on boot). */
  expectReconnect(agentId: string) {
    if (!this.conns.has(agentId)) this.armTimer(agentId, this.config.runnerGraceMs, 'runner did not reconnect')
  }

  private armTimer(agentId: string, ms: number, reason: string) {
    this.clearTimer(agentId)
    const t = setTimeout(() => {
      this.timers.delete(agentId)
      const rec = this.store.agents.get(agentId)
      if (!rec || this.conns.has(agentId) || rec.agent.status === 'error' || rec.agent.status === 'done') return
      this.store.patchAgent(agentId, { status: 'error', currentAction: `Lost contact: ${reason}`, container: { ...rec.agent.container, health: 'degraded' } })
      this.hooks.afterCrash?.(rec.agent, `lost contact (${reason})`)
      this.store.raiseAlert({
        kind: 'crash', severity: 'critical', projectId: rec.agent.projectId, agentId,
        title: `${rec.agent.callsign} lost contact (${reason})`,
        actions: [{ id: 'restart', label: '↻ Restart', primary: true }],
      })
    }, ms)
    t.unref?.()
    this.timers.set(agentId, t)
  }
  private clearTimer(agentId: string) {
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

  handleRunnerMessage(agentId: string, msg: RunnerMessage) {
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
        const ev: ActivityEvent = { ...msg.event, agentId, projectId: rec.agent.projectId }
        this.store.addEvent(ev)
        const action = actionFor(ev)
        if (action && action !== rec.agent.currentAction) this.store.patchAgent(agentId, { currentAction: action })
        this.hooks.afterEvent?.(ev)
        return
      }
      case 'status':
        if (msg.status !== rec.agent.status) this.store.patchAgent(agentId, { status: msg.status })
        return
      case 'usage': {
        const tokens = msg.inputTokens + msg.outputTokens
        this.store.addUsage(agentId, msg.costUsd ?? 0, tokens)
        this.hooks.afterUsage?.(agentId)
        return
      }
      case 'result':
        if (msg.sessionId && msg.sessionId !== rec.sessionId) { rec.sessionId = msg.sessionId; this.store.saveAgent(rec) }
        return
      case 'plan_usage':
        this.store.setPlanUsage(this.withRate(msg.usage), agentId)
        this.hooks.afterPlanUsage?.()
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
          this.hooks.afterCrash?.(rec.agent, `crashed: ${msg.message.slice(0, 300)}`)
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

  // ── commander commands ──────────────────────────────────────────────────────

  /** Send a user_message to the runner, or queue it until the runner says hello. */
  deliver(agentId: string, text: string) {
    const rec = this.get(agentId)
    if (!this.send(agentId, { type: 'user_message', text })) {
      this.store.patchAgent(agentId, {}, { pending: [...rec.internal.pending, text] })
    }
  }

  /** Record a commander action in the agent's feed (kind 'status', the feed's "you" style). */
  private youEvent(rec: AgentRecord, text: string, extra: Partial<ActivityEvent> = {}) {
    this.store.addEvent({ id: newId('ev'), at: nowIso(), agentId: rec.agent.id, projectId: rec.agent.projectId, kind: 'status', text, ...extra })
  }

  message(agentId: string, text: string) {
    const rec = this.get(agentId)
    this.deliver(agentId, text)
    this.store.addEvent({
      id: newId('ev'), at: nowIso(), agentId, projectId: rec.agent.projectId, kind: 'message',
      text: `You → ${rec.agent.callsign}: ${text}`, message: { to: agentId, body: text },
    })
    return { delivered: this.isConnected(agentId), queued: !this.isConnected(agentId) }
  }

  pause(agentId: string, by: 'you' | 'budget' | 'plan_usage' | 'project_budget' = 'you') {
    const rec = this.get(agentId)
    this.send(agentId, { type: 'pause' })
    this.store.patchAgent(agentId, { status: 'paused', currentAction: by === 'you' ? 'Paused by you' : `Paused (${by.replace('_', ' ')})` }, { desired: 'paused', pausedBy: by })
    return this.store.toAgent(rec)
  }

  resume(agentId: string) {
    const rec = this.get(agentId)
    const sent = this.send(agentId, { type: 'resume' })
    this.store.patchAgent(agentId, { status: sent ? 'idle' : rec.agent.status === 'paused' ? 'booting' : rec.agent.status, currentAction: '' }, { desired: 'run', pausedBy: undefined })
    return this.store.toAgent(rec)
  }

  /** Pause every live agent that is not already paused. */
  pauseAll() {
    const paused: string[] = []
    for (const rec of [...this.store.agents.values()]) {
      const a = rec.agent
      if (a.status === 'error' || a.status === 'done' || rec.internal.desired === 'paused') continue
      this.pause(a.id, 'you')
      paused.push(a.id)
    }
    return { paused }
  }

  /** The commander takes the wheel: pause the runner and mark the agent as controlled by you. */
  takeControl(agentId: string) {
    const rec = this.get(agentId)
    if (rec.agent.controller === 'you') return this.store.toAgent(rec)
    this.pause(agentId, 'you')
    this.store.patchAgent(agentId, { controller: 'you', currentAction: 'You have control' })
    this.youEvent(rec, 'You took control', { status: 'paused' })
    return this.store.toAgent(this.get(agentId))
  }

  /** Give control back: resume the agent and tell it what the commander changed. */
  async handBack(agentId: string, note?: string) {
    const rec = this.get(agentId)
    if (rec.agent.controller !== 'you') throw conflict('you do not have control of this agent')
    const changes = await this.workspaceChanges(agentId)
    const lines = [
      'The commander took control of your workspace and has now handed it back to you.',
      '',
      'What changed in /workspace while they had control (`git diff --stat HEAD`):',
      changes.diffStat || '(no changes to tracked files)',
      '',
      '`git status --short`:',
      changes.status || '(clean)',
    ]
    if (changes.error) lines.push('', `(Could not read all workspace changes: ${changes.error})`)
    if (note?.trim()) lines.push('', `Their note: ${note.trim()}`)
    lines.push('', 'Review these changes before you continue. They are the commander\'s work: keep them unless the note says otherwise.')
    const text = lines.join('\n')
    this.store.patchAgent(agentId, { controller: 'agent' })
    this.resume(agentId)
    this.deliver(agentId, text)
    this.youEvent(rec, 'You handed control back', { message: { to: agentId, body: text } })
    return { agent: this.store.toAgent(this.get(agentId)), message: text }
  }

  private async workspaceChanges(agentId: string): Promise<{ diffStat: string; status: string; error?: string }> {
    const run = this.infra.execInAgent?.bind(this.infra)
    if (!run) return { diffStat: '', status: '', error: 'the infrastructure driver cannot run commands in agent containers' }
    const errors: string[] = []
    const one = async (cmd: string[]) => {
      try {
        const r = await run(agentId, cmd, { timeoutMs: 20_000 })
        if (r.exitCode !== 0) errors.push(`${cmd.slice(3).join(' ')} exited ${r.exitCode}: ${clip(r.stderr.trim() || r.stdout.trim(), 200)}`)
        return clip(r.stdout.replace(/\s+$/, ''), 4000)
      } catch (e) {
        errors.push(`${cmd.slice(3).join(' ')}: ${clip((e as Error).message, 200)}`)
        return ''
      }
    }
    const [diffStat, status] = await Promise.all([
      one(['git', '-C', '/workspace', 'diff', '--stat', 'HEAD']),
      one(['git', '-C', '/workspace', 'status', '--short']),
    ])
    return { diffStat, status, ...(errors.length ? { error: errors.join('; ') } : {}) }
  }

  interrupt(agentId: string) {
    this.get(agentId)
    if (!this.send(agentId, { type: 'interrupt' })) throw conflict('agent runner is not connected')
    return { ok: true }
  }

  async restart(agentId: string) {
    const rec = this.get(agentId)
    const token = randomBytes(32).toString('base64url')
    rec.tokenHash = sha256(token)
    this.store.saveAgent(rec)
    this.conns.get(agentId)?.close(4001, 'restarting')
    this.conns.delete(agentId)
    this.store.connected.delete(agentId)
    this.store.patchAgent(agentId, { status: 'booting', currentAction: 'Restarting' })
    await this.startContainer(rec, token)
    return this.store.toAgent(this.get(agentId))
  }

  async kill(agentId: string, opts: { purge?: boolean } = {}) {
    const rec = this.get(agentId)
    this.send(agentId, { type: 'shutdown' })
    try {
      await this.infra.stopAgent(agentId, { remove: true })
      if (opts.purge) await this.infra.removeAgentVolume(agentId)
    } catch (e) {
      throw infraError(e, 'failed to remove agent container')
    }
    this.clearTimer(agentId)
    this.conns.get(agentId)?.close(1000, 'agent removed')
    this.conns.delete(agentId)
    for (const a of this.store.alerts.values()) if (a.agentId === agentId && !a.resolvedAt) this.store.resolveAlert(a.id)
    this.store.deleteAgent(agentId)
    this.hooks.afterRemove?.(rec.agent)
    this.store.broadcastSnapshot()
    return { ok: true, id: rec.agent.id }
  }

  patch(agentId: string, input: PatchInput) {
    const rec = this.get(agentId)
    const patch: Partial<Agent> = {}
    if (input.model !== undefined) {
      const m = findModel(input.model)
      if (!m) throw badRequest(`unknown model '${input.model}'`)
      if (m.id !== rec.agent.model) {
        patch.model = m.id
        patch.provider = m.provider
      }
    }
    if (input.rolePrompt !== undefined) patch.rolePrompt = input.rolePrompt // applies on next restart
    if (input.budgetCapUsd !== undefined) patch.budgetCapUsd = input.budgetCapUsd
    this.store.patchAgent(agentId, patch)
    if (patch.model) this.send(agentId, { type: 'set_model', model: patch.model })
    if (patch.budgetCapUsd !== undefined) this.hooks.afterUsage?.(agentId)
    return { agent: this.store.toAgent(this.get(agentId)), restartRequired: input.rolePrompt !== undefined }
  }

  /** Close all runner sockets (graceful shutdown; runners reconnect to the next instance). */
  closeAll() {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const c of this.conns.values()) c.close(1012, 'control plane restarting')
    this.conns.clear()
  }
}

/** First message to a new orchestrator: plan, then get the commander's OK before staffing. */
export function kickoff(goal: string): string {
  return [
    '[Colony] Kickoff. The commander founded this base with the goal in your instructions:',
    '',
    `> ${goal.trim().replace(/\n/g, '\n> ')}`,
    '',
    '1. Read enough of the repository to understand its structure, stack and current state.',
    '2. Create the first batch of quests with create_task (brief, acceptance criteria, dependencies).',
    '3. Present the plan with request_human: a few lines on the approach and the quests, with options "Approve plan" and "Change it".',
    "4. Wait for the commander's answer before you spawn or assign any workers.",
  ].join('\n')
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + '\n…' : t)

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
