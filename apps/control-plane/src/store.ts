// In-memory state hydrated from the DB. Every mutation writes through to SQLite and emits
// a UiStreamMessage for the UI hub. Derived fields (spend, level/xp, health, uptime,
// session share) are computed here so every Snapshot is complete.

import { cpus, freemem, totalmem } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
  BUILTIN_MODELS, BUILTIN_MODEL_IDS, PROTOCOL_VERSION,
  type ActivityEvent, type Agent, type Alert, type Guards, type MergeRequest, type PlanUsage,
  type Project, type ProviderConfig, type Quest, type Resources, type Snapshot, type UiStreamMessage,
} from '@colony/shared'
import type { Config } from './config'
import type { Db, Row } from './db'

// ── internal records ──────────────────────────────────────────────────────────

export interface ProjectRecord {
  /** Stored part of the Project; derived fields are filled by toProject(). */
  project: Project
  slug: string
  createdAt: string
}

export interface AgentInternal {
  /** What the commander wants: 'run' or 'paused'. Re-applied when the runner (re)connects. */
  desired: 'run' | 'paused'
  /** Why it was paused (guards don't re-alert, and know what they paused). */
  pausedBy?: 'you' | 'budget' | 'plan_usage' | 'project_budget'
  /** Messages for the runner that arrived while it was not connected (initial task first). */
  pending: string[]
  startedAt: string
  lastSeenAt?: string
}

export interface AgentRecord {
  agent: Agent
  internal: AgentInternal
  tokenHash: string
  sessionId?: string
  createdAt: string
}

export const DEFAULT_GUARDS: Guards = {
  warnAtPct: 70, pauseWorkersAtPct: 90, orchestratorReservePct: 5, weeklyWarnAtPct: 70,
  paceForecast: true, resumeAfterReset: false,
}

export const nowIso = () => new Date().toISOString()
export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const newId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex')}`

export function defaultPlanUsage(): PlanUsage {
  const t = nowIso()
  return { session: { usedPct: 0, resetsAt: t, ratePctPerHour: 0 }, weekly: { usedPct: 0, resetsAt: t }, syncedAt: t, source: 'unavailable' }
}

/** Level/xp from completed quests: 5 quests per level, xp is progress within the level. */
export function levelFor(questsDone: number) {
  return { level: 1 + Math.floor(questsDone / 5), xp: (questsDone % 5) * 20 }
}

export function slugify(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '')
  return s || 'project'
}

type Listener = (msg: UiStreamMessage) => void

export type ColonySnapshot = Snapshot & { guards: Guards }

export class Store {
  readonly projects = new Map<string, ProjectRecord>()
  readonly agents = new Map<string, AgentRecord>()
  readonly alerts = new Map<string, Alert>()
  readonly mergeRequests = new Map<string, MergeRequest>()
  readonly quests = new Map<string, Quest>()
  usage: PlanUsage
  sessionShares: { resetsAt: string; byAgent: Record<string, number> } = { resetsAt: "", byAgent: {} }
  guards: Guards
  dockerUp = false
  runningContainers = 0
  /** Agents with a connected runner (set by the runner hub). */
  readonly connected = new Set<string>()
  private day = localDay()
  private listeners = new Set<Listener>()
  private cpuSample = sampleCpu()
  private hostCpuPct = 0

  constructor(readonly db: Db, readonly config: Config) {
    for (const r of db.all('SELECT * FROM projects ORDER BY key')) {
      this.projects.set(String(r.id), { project: JSON.parse(String(r.data)), slug: String(r.slug), createdAt: String(r.created_at) })
    }
    for (const r of db.all('SELECT * FROM agents ORDER BY created_at')) {
      this.agents.set(String(r.id), {
        agent: JSON.parse(String(r.data)), internal: JSON.parse(String(r.internal)),
        tokenHash: String(r.token_hash), sessionId: (r.session_id as string | null) ?? undefined, createdAt: String(r.created_at),
      })
    }
    for (const r of db.all('SELECT json FROM alerts ORDER BY at')) { const a = JSON.parse(String(r.json)) as Alert; this.alerts.set(a.id, a) }
    for (const r of db.all('SELECT json FROM merge_requests')) { const m = JSON.parse(String(r.json)) as MergeRequest; this.mergeRequests.set(m.id, m) }
    for (const r of db.all('SELECT json FROM quests')) { const q = JSON.parse(String(r.json)) as Quest; this.quests.set(q.id, q) }
    this.usage = db.kvGet<PlanUsage>('plan_usage') ?? defaultPlanUsage()
    this.sessionShares = db.kvGet<{ resetsAt: string; byAgent: Record<string, number> }>('session_shares') ?? { resetsAt: '', byAgent: {} }
    this.guards = { ...DEFAULT_GUARDS, ...(db.kvGet<Guards>('guards') ?? {}) }
    this.recomputeSpend()
  }

  // ── events to the UI ──
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit(msg: UiStreamMessage) {
    for (const fn of this.listeners) {
      try { fn(msg) } catch { /* a bad listener must not break the store */ }
    }
  }
  broadcastSnapshot() { this.emit({ type: 'snapshot', snapshot: this.snapshot(), protocol: PROTOCOL_VERSION }) }
  broadcastResources() { this.emit({ type: 'resources', resources: this.resources() }) }

  // ── projects ──
  usedKeys() { return new Set([...this.projects.values()].map((p) => p.project.key)) }
  nextKey(): number {
    const used = this.usedKeys()
    for (let k = 1; k <= 9; k++) if (!used.has(k)) return k
    return 0 // no keyboard slot left
  }
  uniqueSlug(name: string): string {
    const base = slugify(name)
    const taken = new Set([...this.projects.values()].map((p) => p.slug))
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  }
  saveProject(rec: ProjectRecord) {
    this.projects.set(rec.project.id, rec)
    this.db.run(
      `INSERT INTO projects(id, slug, key, data, created_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET key = excluded.key, data = excluded.data`,
      rec.project.id, rec.slug, rec.project.key, JSON.stringify(rec.project), rec.createdAt,
    )
  }
  deleteProject(id: string) {
    this.projects.delete(id)
    for (const [aid, a] of this.alerts) if (a.projectId === id) this.alerts.delete(aid)
    for (const [mid, m] of this.mergeRequests) if (m.projectId === id) this.mergeRequests.delete(mid)
    for (const [qid, q] of this.quests) if (q.projectId === id) this.quests.delete(qid)
    this.db.tx(() => {
      this.db.run('DELETE FROM projects WHERE id = ?', id)
      this.db.run('DELETE FROM alerts WHERE project_id = ?', id)
      this.db.run('DELETE FROM merge_requests WHERE project_id = ?', id)
      this.db.run('DELETE FROM quests WHERE project_id = ?', id)
      this.db.run('DELETE FROM events WHERE project_id = ?', id)
    })
  }
  projectAgents(projectId: string): AgentRecord[] {
    return [...this.agents.values()].filter((a) => a.agent.projectId === projectId)
  }

  // ── agents ──
  saveAgent(rec: AgentRecord) {
    this.agents.set(rec.agent.id, rec)
    this.db.run(
      `INSERT INTO agents(id, project_id, callsign, token_hash, session_id, data, internal, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, session_id = excluded.session_id, data = excluded.data, internal = excluded.internal`,
      rec.agent.id, rec.agent.projectId, rec.agent.callsign, rec.tokenHash, rec.sessionId ?? null,
      JSON.stringify(rec.agent), JSON.stringify(rec.internal), rec.createdAt,
    )
  }
  /** Merge a patch into an agent, persist, and emit an agent_delta with the public fields. */
  patchAgent(id: string, patch: Partial<Agent>, internal?: Partial<AgentInternal>) {
    const rec = this.agents.get(id)
    if (!rec) return
    rec.agent = { ...rec.agent, ...patch }
    if (internal) rec.internal = { ...rec.internal, ...internal }
    this.saveAgent(rec)
    if (Object.keys(patch).length) this.emit({ type: 'agent_delta', agentId: id, patch })
  }
  deleteAgent(id: string) {
    this.agents.delete(id)
    this.connected.delete(id)
    this.db.tx(() => {
      this.db.run('DELETE FROM agents WHERE id = ?', id)
      this.db.run('DELETE FROM events WHERE agent_id = ?', id)
    })
  }
  agentByTokenHash(hash: string): AgentRecord | undefined {
    for (const a of this.agents.values()) if (a.tokenHash === hash) return a
    return undefined
  }
  callsignTaken(callsign: string) {
    const c = callsign.toLowerCase()
    return [...this.agents.values()].some((a) => a.agent.callsign.toLowerCase() === c)
  }

  // ── events ──
  /** Persist (upsert by id) and broadcast an activity event. */
  addEvent(ev: ActivityEvent) {
    this.db.run(
      `INSERT INTO events(id, agent_id, project_id, at, json) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, id) DO UPDATE SET json = excluded.json, at = excluded.at`,
      ev.id, ev.agentId, ev.projectId, ev.at, JSON.stringify(ev),
    )
    this.trimEvents(ev.agentId)
    this.emit({ type: 'event', event: ev })
  }
  private trimCounter = new Map<string, number>()
  private trimEvents(agentId: string) {
    const n = (this.trimCounter.get(agentId) ?? 0) + 1
    this.trimCounter.set(agentId, n)
    if (n % 50 !== 0) return
    this.db.run(
      `DELETE FROM events WHERE agent_id = ? AND seq <= (SELECT seq FROM events WHERE agent_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
      agentId, agentId, this.config.eventsPerAgent,
    )
  }
  agentEvents(agentId: string, limit: number): ActivityEvent[] {
    return this.db.all('SELECT json FROM events WHERE agent_id = ? ORDER BY seq DESC LIMIT ?', agentId, limit)
      .map((r) => JSON.parse(String(r.json)) as ActivityEvent).reverse()
  }
  recentEvents(limit = 200): ActivityEvent[] {
    return this.db.all('SELECT json FROM events ORDER BY seq DESC LIMIT ?', limit)
      .map((r) => JSON.parse(String(r.json)) as ActivityEvent).reverse()
  }

  // ── alerts ──
  upsertAlert(a: Alert) {
    this.alerts.set(a.id, a)
    this.db.run(
      `INSERT INTO alerts(id, at, project_id, agent_id, resolved_at, json) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET resolved_at = excluded.resolved_at, json = excluded.json`,
      a.id, a.at, a.projectId ?? null, a.agentId ?? null, a.resolvedAt ?? null, JSON.stringify(a),
    )
    this.emit({ type: 'alert', alert: a })
    if (a.projectId) this.emitProjectChanged()
  }
  raiseAlert(a: Omit<Alert, 'id' | 'at' | 'actions'> & Partial<Pick<Alert, 'id' | 'actions'>>): Alert {
    const alert: Alert = { id: a.id ?? newId('al'), at: nowIso(), actions: a.actions ?? [], ...a }
    this.upsertAlert(alert)
    return alert
  }
  resolveAlert(id: string): Alert | undefined {
    const a = this.alerts.get(id)
    if (!a || a.resolvedAt) return a
    const next = { ...a, resolvedAt: nowIso() }
    this.upsertAlert(next)
    return next
  }
  /** Projects carry unreadAlerts; there is no project delta message, so resend the snapshot lazily. */
  private projectChangedTimer: NodeJS.Timeout | undefined
  emitProjectChanged() {
    if (this.projectChangedTimer) return
    this.projectChangedTimer = setTimeout(() => { this.projectChangedTimer = undefined; this.broadcastSnapshot() }, 250)
    this.projectChangedTimer.unref?.()
  }
  /** Stop timers and listeners (before the DB is closed). */
  dispose() {
    if (this.projectChangedTimer) clearTimeout(this.projectChangedTimer)
    this.projectChangedTimer = undefined
    this.listeners.clear()
  }

  // ── merge requests ──
  saveMergeRequest(mr: MergeRequest) {
    this.mergeRequests.set(mr.id, mr)
    this.db.run(
      `INSERT INTO merge_requests(id, project_id, status, json) VALUES(?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json`,
      mr.id, mr.projectId, mr.status, JSON.stringify(mr),
    )
  }

  // ── quests ──
  saveQuest(q: Quest) {
    this.quests.set(q.id, q)
    this.db.run(
      `INSERT INTO quests(id, project_id, json) VALUES(?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      q.id, q.projectId, JSON.stringify(q),
    )
  }
  projectQuests(projectId: string): Quest[] {
    return [...this.quests.values()].filter((q) => q.projectId === projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // ── usage & spend ──
  /** Add a usage delta for an agent (persisted per local day). */
  addUsage(agentId: string, costUsd: number, tokens: number) {
    const rec = this.agents.get(agentId)
    if (!rec) return
    this.rollDayIfNeeded()
    this.db.run(
      `INSERT INTO usage_daily(day, agent_id, project_id, cost_usd, tokens) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(day, agent_id) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, tokens = tokens + excluded.tokens`,
      this.day, agentId, rec.agent.projectId, costUsd, tokens,
    )
    this.patchAgent(agentId, {
      spendTodayUsd: round2(rec.agent.spendTodayUsd + costUsd),
      tokensToday: rec.agent.tokensToday + tokens,
    })
  }
  /** Reload today's per-agent spend/tokens from the DB. */
  recomputeSpend() {
    const rows = new Map(this.db.all('SELECT agent_id, cost_usd, tokens FROM usage_daily WHERE day = ?', this.day).map((r) => [String(r.agent_id), r]))
    for (const rec of this.agents.values()) {
      const r = rows.get(rec.agent.id)
      rec.agent.spendTodayUsd = round2(Number(r?.cost_usd ?? 0))
      rec.agent.tokensToday = Number(r?.tokens ?? 0)
    }
  }
  /** Returns true when the local day changed (spend counters reset). */
  rollDayIfNeeded(): boolean {
    const d = localDay()
    if (d === this.day) return false
    this.day = d
    this.recomputeSpend()
    this.broadcastSnapshot()
    return true
  }
  today() { return this.day }
  projectSpendToday(projectId: string): number {
    return round2(Number(this.db.get('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_daily WHERE day = ? AND project_id = ?', this.day, projectId)?.s ?? 0))
  }
  spendToday(): number {
    return round2(Number(this.db.get('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_daily WHERE day = ?', this.day)?.s ?? 0))
  }
  spendMonth(): number {
    return round2(Number(this.db.get('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_daily WHERE day LIKE ?', this.day.slice(0, 7) + '-%')?.s ?? 0))
  }
  /** Credit an agent with the rise in session usage between its own plan_usage reports, so a
   *  base's share reflects what Colony's agents used, not the whole plan (which also counts usage
   *  outside Colony). The first report in a window has no baseline and credits nothing. */
  setPlanUsage(u: PlanUsage, fromAgentId?: string) {
    const prev = this.usage
    if (this.sessionShares.resetsAt !== u.session.resetsAt) this.sessionShares = { resetsAt: u.session.resetsAt, byAgent: {} }
    else if (fromAgentId && prev.source === 'connected' && prev.session.resetsAt === u.session.resetsAt) {
      const delta = u.session.usedPct - prev.session.usedPct
      if (delta > 0) this.sessionShares.byAgent[fromAgentId] = (this.sessionShares.byAgent[fromAgentId] ?? 0) + delta
    }
    this.db.kvSet('session_shares', this.sessionShares)
    this.usage = u
    this.db.kvSet('plan_usage', u)
    this.broadcastResources()
  }

  // ── derived views ──
  private sessionShareOf(agentIds: string[]) {
    if (this.usage.source !== 'connected') return 0
    return round2(agentIds.reduce((n, id) => n + (this.sessionShares.byAgent[id] ?? 0), 0) / 100)
  }
  private totalTokens() {
    let t = 0
    for (const a of this.agents.values()) t += a.agent.tokensToday
    return t
  }

  toAgent(rec: AgentRecord, totalTokens = this.totalTokens()): Agent {
    const a = rec.agent
    const { level, xp } = levelFor(a.questsDone)
    const started = Date.parse(rec.internal.startedAt)
    const live = a.status !== 'error' && a.status !== 'done'
    return {
      ...a,
      level, xp,
      sessionShare: this.sessionShareOf([a.id]),
      uptimeSec: live && Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0,
    }
  }

  toProject(rec: ProjectRecord, totalTokens = this.totalTokens()): Project {
    const p = rec.project
    const agents = this.projectAgents(p.id)
    const unread = [...this.alerts.values()].filter((a) => a.projectId === p.id && !a.resolvedAt).length
    const tokens = agents.reduce((s, a) => s + a.agent.tokensToday, 0)
    return {
      ...p,
      agentIds: agents.map((a) => a.agent.id),
      orchestratorId: agents.find((a) => a.agent.role === 'orchestrator')?.agent.id,
      health: projectHealth(agents.map((a) => a.agent)),
      spendTodayUsd: round2(agents.reduce((s, a) => s + a.agent.spendTodayUsd, 0)),
      sessionShare: this.sessionShareOf(agents.map((x) => x.agent.id)),
      unreadAlerts: unread,
    }
  }

  resources(): Resources {
    const host = this.hostStats()
    return {
      usage: this.usage,
      spendTodayUsd: this.spendToday(),
      dailyCapUsd: this.config.dailyCapUsd,
      spendMonthUsd: this.spendMonth(),
      containers: { running: this.runningContainers, max: this.config.maxContainers },
      host: { ...host, docker: this.dockerUp ? 'running' : 'down' },
    }
  }

  /** Called by the stats poller so host CPU% is measured over the poll interval. */
  sampleHost() {
    const s = sampleCpu()
    const idle = s.idle - this.cpuSample.idle, total = s.total - this.cpuSample.total
    this.cpuSample = s
    if (total > 0) this.hostCpuPct = Math.round((1 - idle / total) * 100)
  }
  private hostStats() {
    const gb = (b: number) => Math.round((b / 1024 ** 3) * 10) / 10
    const tot = totalmem()
    return { cpuPct: this.hostCpuPct, memUsedGb: gb(tot - freemem()), memTotalGb: gb(tot) }
  }

  /** Provider list for snapshots; app.ts points this at the ProviderService. */
  providerList: () => ProviderConfig[] = () => {
    const has = !!this.config.oauthToken
    return [{
      id: 'claude-subscription', label: 'Claude subscription', kind: 'subscription', hasKey: has,
      models: [...BUILTIN_MODEL_IDS], status: has ? 'untested' : 'missing_key',
    }]
  }
  providers(): ProviderConfig[] { return this.providerList() }

  // ── guards ──
  /** Merge a (validated) patch into the guards, persist in kv, and resend the snapshot. */
  setGuards(patch: Partial<Guards>): Guards {
    const next: Guards = { ...this.guards, ...patch }
    for (const k of Object.keys(next) as (keyof Guards)[]) if (next[k] === undefined) delete next[k]
    this.guards = next
    this.db.kvSet('guards', next)
    this.broadcastSnapshot()
    return next
  }

  /** Snapshot plus `guards` (docs/phase2.md; not yet in the shared SnapshotSchema). */
  snapshot(): ColonySnapshot {
    const total = this.totalTokens()
    return {
      guards: { ...this.guards },
      projects: [...this.projects.values()].sort((a, b) => (a.project.key || 99) - (b.project.key || 99)).map((p) => this.toProject(p, total)),
      agents: [...this.agents.values()].map((a) => this.toAgent(a, total)),
      quests: [...this.quests.values()],
      alerts: [...this.alerts.values()].sort((a, b) => a.at.localeCompare(b.at)),
      resources: this.resources(),
      events: this.recentEvents(),
      mergeRequests: [...this.mergeRequests.values()],
      providers: this.providers(),
      models: [...BUILTIN_MODELS],
    }
  }
}

export function projectHealth(agents: Agent[]): Project['health'] {
  if (agents.length === 0) return { score: 0, label: 'dormant' }
  const bad = agents.filter((a) => a.status === 'error' || a.container.health === 'down').length
  const live = agents.filter((a) => a.status !== 'paused' && a.status !== 'done').length
  if (bad === agents.length) return { score: 0, label: 'down' }
  if (live === 0) return { score: 0, label: 'dormant' }
  const score = Math.round(10 * (1 - bad / agents.length))
  return { score, label: bad > 0 ? 'strained' : 'stable' }
}

const round2 = (n: number) => Math.round(n * 10000) / 10000

function sampleCpu() {
  let idle = 0, total = 0
  for (const c of cpus()) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  return { idle, total }
}

export type { Row }
