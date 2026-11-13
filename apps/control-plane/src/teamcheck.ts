// Team check-ins (feedback #8). An orchestrator only acts when it receives a message, so the
// "check on your workers periodically" guidance never fired on its own. While a base has busy
// workers, Colony sends its orchestrator a compact "[Colony] Team check" digest every
// `guards.teamCheckMinutes` (default 5, 0 = off): what each worker is doing, for how long, what it
// touched, whether it has pushed, and signs it may be stuck or off task. Digests that say nothing
// new are skipped to save usage, and none are sent while workers are paused by the plan guard.

import type { ActivityEvent, Quest } from '@colony/shared'
import type { AgentManager } from './agents'
import type { InfraDriver } from './infra/types'
import { newId, nowIso, type AgentRecord, type Store } from './store'

const BUSY = new Set(['running', 'thinking', 'editing'])
const ORCH_BUSY = new Set(['running', 'thinking', 'editing', 'booting'])
const NO_COMMIT_FLAG_MS = 20 * 60_000
const QUIET_FLAG_MS = 8 * 60_000

export interface WorkerDigest {
  callsign: string
  id: string
  line: string
  flags: string[]
  /** Changes when the worker's situation changes (used to skip repeat digests). */
  signature: string
}

/** Paths a brief says the worker owns ("Owns: a, b" line or a "## Owns" bullet section). */
export function ownedPaths(brief: string): string[] {
  const out: string[] = []
  const lines = brief.split(/\r?\n/)
  let inSection = false
  for (const l of lines) {
    const inline = /^\s*(?:\*\*)?owns(?:\*\*)?\s*:\s*(.+)$/i.exec(l)
    if (inline) { out.push(...inline[1].split(/[,;]/)); continue }
    if (/^\s*#{1,4}\s/.test(l)) { inSection = /^\s*#{1,4}\s*owns\s*:?\s*$/i.test(l); continue }
    if (inSection) {
      const m = /^\s*[-*]\s+(.+)$/.exec(l)
      if (m) out.push(...m[1].split(/[,;]/))
    }
  }
  return out
    // Drop notes like "foo.ts (shared)" but keep route groups such as src/app/(auth)/.
    .map((p) => p.replace(/`/g, '').replace(/\s+\(.*?\)/g, '').trim().replace(/^\.\//, ''))
    .filter((p) => p && /[/.]/.test(p) && p.length < 200)
}

/** Is `path` inside one of the owned globs/paths? (prefix match; `**` and `*` treated as wildcards). */
export function withinOwned(path: string, owned: string[]): boolean {
  const p = path.replace(/^\.\//, '').replace(/^\/workspace\//, '')
  return owned.some((o) => {
    const base = o.split('*')[0].replace(/\/+$/, '')
    if (!base) return true
    return p === base || p.startsWith(`${base}/`) || p.startsWith(base)
  })
}

export class TeamCheckService {
  private lastSent = new Map<string, number>()
  private lastSignature = new Map<string, string>()
  private questSince = new Map<string, { quest: string; since: number }>()
  private running = new Set<string>()

  constructor(private store: Store, private agents: AgentManager, private infra: InfraDriver, private now: () => number = Date.now) {}

  private minutes() { return this.store.guards.teamCheckMinutes ?? 5 }

  /** Called on every stats tick. */
  async tick() {
    const every = this.minutes()
    if (!every) return
    const t = this.now()
    for (const p of this.store.projects.values()) {
      const id = p.project.id
      const last = this.lastSent.get(id) ?? 0
      if (t - last < every * 60_000) continue
      await this.check(id, { force: false }).catch(() => {})
    }
  }

  /** Build and (unless nothing changed) send a digest to the base's orchestrator. */
  async check(projectId: string, opts: { force: boolean }): Promise<{ sent: boolean; reason?: string; digest?: string }> {
    if (this.running.has(projectId)) return { sent: false, reason: 'a check is already running' }
    this.running.add(projectId)
    try {
      const prec = this.store.projects.get(projectId)
      if (!prec) return { sent: false, reason: 'no such base' }
      const all = this.store.projectAgents(projectId)
      const orch = all.find((a) => a.agent.role === 'orchestrator')
      if (!orch) return { sent: false, reason: 'no orchestrator' }
      if (orch.internal.desired === 'paused' || orch.agent.status === 'paused') return { sent: false, reason: 'orchestrator paused' }
      const workers = all.filter((a) => a.agent.role !== 'orchestrator' && a.agent.status !== 'done')
      const busy = workers.filter((w) => BUSY.has(w.agent.status))
      if (!opts.force && !busy.length) return { sent: false, reason: 'no busy workers' }
      if (!opts.force && ORCH_BUSY.has(orch.agent.status)) return { sent: false, reason: 'orchestrator busy; next tick' }
      let branches: Awaited<ReturnType<InfraDriver['listBranches']>> = []
      try { branches = await this.infra.listBranches(prec.slug) } catch { /* digest without commit info */ }
      const digests = workers.map((w) => this.digest(w, branches))
      const signature = digests.map((d) => d.signature).join('|')
      if (!opts.force && signature === this.lastSignature.get(projectId)) {
        this.lastSent.set(projectId, this.now())
        return { sent: false, reason: 'nothing changed since the last check' }
      }
      const flagged = digests.filter((d) => d.flags.length)
      const text = [
        `[Colony] Team check (${new Date(this.now()).toISOString().slice(11, 16)} UTC, every ${this.minutes()} min${opts.force ? ', requested by the commander' : ''}):`,
        ...digests.map((d) => `- ${d.line}${d.flags.length ? `\n  ⚠ ${d.flags.join('; ')}` : ''}`),
        '',
        flagged.length
          ? `Look at the flagged worker${flagged.length === 1 ? '' : 's'} (get_agent_status / review_branch). If one is stuck or off task, redirect it with message_agent (a hint, a narrower scope), or stop it and reassign with a sharper brief. If a nudge from an earlier check didn't help, tell the commander with request_human. Reply with one line per worker: on track / nudged / reassigned.`
          : 'Nothing looks stuck. Reply with one short line only if you change something; no need to poll further.',
      ].join('\n')
      this.agents.deliver(orch.agent.id, text)
      this.store.addEvent({
        id: newId('ev'), at: nowIso(), agentId: orch.agent.id, projectId, kind: 'status',
        text: `Team check sent to ${orch.agent.callsign}: ${workers.length} worker${workers.length === 1 ? '' : 's'}${flagged.length ? `, ${flagged.length} flagged (${flagged.map((f) => f.callsign).join(', ')})` : ', none flagged'}`,
      })
      this.lastSent.set(projectId, this.now())
      this.lastSignature.set(projectId, signature)
      return { sent: true, digest: text }
    } finally {
      this.running.delete(projectId)
    }
  }

  digest(w: AgentRecord, branches: { name: string; aheadOfMain: number }[]): WorkerDigest {
    const a = w.agent
    const t = this.now()
    const quest: Quest | undefined = a.currentTaskId ? this.store.quests.get(a.currentTaskId) : undefined
    const prev = this.questSince.get(a.id)
    if (!prev || prev.quest !== (quest?.id ?? '')) this.questSince.set(a.id, { quest: quest?.id ?? '', since: t })
    const onQuestMs = t - (this.questSince.get(a.id)!.since)
    const events: ActivityEvent[] = this.store.agentEvents(a.id, 60)
    const lastAt = events.length ? Date.parse(events[events.length - 1].at) : NaN
    const quietMs = Number.isFinite(lastAt) ? t - lastAt : Infinity
    const edits = [...new Set(events.filter((e) => e.kind === 'edit' && e.edit?.path).map((e) => e.edit!.path))].slice(-6)
    const cmds = events.filter((e) => e.kind === 'command' && e.command?.cmd).map((e) => e.command!.cmd.trim())
    const repeats = cmds.length ? Math.max(...[...new Set(cmds)].map((c) => cmds.filter((x) => x === c).length)) : 0
    const ahead = a.branch ? branches.find((b) => b.name === a.branch)?.aheadOfMain ?? 0 : 0
    const flags: string[] = []
    if (BUSY.has(a.status) && quest && onQuestMs > NO_COMMIT_FLAG_MS && ahead === 0) flags.push(`no commits pushed after ${Math.round(onQuestMs / 60_000)} min on the quest`)
    if (BUSY.has(a.status) && quietMs > QUIET_FLAG_MS && quietMs !== Infinity) flags.push(`no activity for ${Math.round(quietMs / 60_000)} min`)
    if (repeats >= 4) flags.push(`repeated the same command ${repeats}× recently`)
    if (a.contextPct >= 85) flags.push(`context ${a.contextPct}% (near the limit)`)
    if (a.budgetCapUsd > 0 && a.spendTodayUsd >= a.budgetCapUsd * 0.8) flags.push(`spend $${a.spendTodayUsd.toFixed(2)} of its $${a.budgetCapUsd.toFixed(2)} cap`)
    const owned = quest ? ownedPaths(quest.brief) : []
    const outside = owned.length ? edits.filter((p) => !withinOwned(p, owned)) : []
    if (outside.length) flags.push(`edited outside its quest's area: ${outside.slice(0, 3).join(', ')}`)
    if (!quest && BUSY.has(a.status)) flags.push('busy without an assigned quest')
    const line = [
      `${a.callsign} (${a.role}, ${a.model}) ${a.status}`,
      quest ? `on ${quest.id} "${quest.title}" for ${Math.round(onQuestMs / 60_000)} min` : 'no quest',
      a.currentAction ? `now: ${a.currentAction.slice(0, 90)}` : '',
      edits.length ? `touched ${edits.join(', ')}` : '',
      `${ahead} commit${ahead === 1 ? '' : 's'} pushed`,
      `ctx ${a.contextPct}%`,
    ].filter(Boolean).join(' · ')
    const signature = [a.id, a.status, quest?.id ?? '', a.currentAction ?? '', ahead, edits.join(','), flags.join(',')].join('~')
    return { callsign: a.callsign, id: a.id, line, flags, signature }
  }
}
