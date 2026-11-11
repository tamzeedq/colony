// Loop detection (docs/phase3.md "Guardrails"):
// - repeats: the same command/tool/edit signature ≥ REPEAT_MIN times in an agent's last
//   WINDOW events → `loop` alert (once per signature per 30 min) and the orchestrator is told;
// - stalls: busy (thinking/running/editing) with no event for STALL_MS → `loop` alert.

import type { ActivityEvent, Agent } from '@colony/shared'
import type { QuestService } from './quests'
import type { Store } from './store'

const WINDOW = 12
const REPEAT_MIN = 6
const REALERT_MS = 30 * 60_000
const BUSY = new Set(['thinking', 'running', 'editing'])

export interface LoopOptions {
  stallMs?: number
  checkEveryMs?: number
  now?: () => number
}

export class LoopDetector {
  private recent = new Map<string, { id: string; sig: string }[]>()
  private lastEventAt = new Map<string, number>()
  private alerted = new Map<string, number>()
  private timer: NodeJS.Timeout | undefined
  private stallMs: number
  private checkEveryMs: number
  private now: () => number

  constructor(private store: Store, private quests: QuestService, opts: LoopOptions = {}) {
    this.stallMs = opts.stallMs ?? 15 * 60_000
    this.checkEveryMs = opts.checkEveryMs ?? 60_000
    this.now = opts.now ?? Date.now
  }

  start() {
    this.timer = setInterval(() => this.checkStalls(), this.checkEveryMs)
    this.timer.unref?.()
  }
  stop() { if (this.timer) clearInterval(this.timer) }

  forget(agentId: string) {
    this.recent.delete(agentId)
    this.lastEventAt.delete(agentId)
    for (const k of this.alerted.keys()) if (k.startsWith(`${agentId}|`)) this.alerted.delete(k)
  }

  onEvent(ev: ActivityEvent) {
    this.lastEventAt.set(ev.agentId, this.now())
    const sig = signature(ev)
    if (!sig) return
    // A running command later gains its exit code under the same event id: count it once.
    const list = this.recent.get(ev.agentId) ?? []
    if (list.some((x) => x.id === ev.id)) return
    list.push({ id: ev.id, sig })
    if (list.length > WINDOW) list.shift()
    this.recent.set(ev.agentId, list)
    const count = list.filter((x) => x.sig === sig).length
    if (count < REPEAT_MIN) return
    const rec = this.store.agents.get(ev.agentId)
    if (!rec || !this.fire(`${ev.agentId}|${sig}`)) return
    const what = sig.slice(sig.indexOf(':') + 1).slice(0, 120)
    this.raise(rec.agent, `${rec.agent.callsign} may be looping`, `Repeated ${count}× in its last ${list.length} steps: ${what}`)
  }

  checkStalls() {
    const t = this.now()
    for (const rec of this.store.agents.values()) {
      const a = rec.agent
      if (!BUSY.has(a.status) || rec.internal.desired === 'paused' || a.controller === 'you') continue
      const last = this.lastEventAt.get(a.id)
      if (last === undefined) { this.lastEventAt.set(a.id, t); continue }
      if (t - last < this.stallMs) continue
      if (!this.fire(`${a.id}|stall`)) continue
      this.raise(a, `${a.callsign} has made no progress for ${Math.round((t - last) / 60_000)} min`, `Status ${a.status}${a.currentAction ? ` · ${a.currentAction}` : ''}`)
    }
  }

  private fire(key: string): boolean {
    const t = this.now()
    const prev = this.alerted.get(key)
    if (prev !== undefined && t - prev < REALERT_MS) return false
    this.alerted.set(key, t)
    return true
  }

  private raise(a: Agent, title: string, detail: string) {
    this.store.raiseAlert({
      kind: 'loop', severity: 'needs_you', projectId: a.projectId, agentId: a.id, title, detail,
      actions: [{ id: 'nudge', label: 'Nudge', primary: true }, { id: 'take-control', label: 'Take control', actsAsYou: true }, { id: 'restart', label: '↻ Restart' }],
    })
    if (a.role !== 'orchestrator') {
      this.quests.notifyOrchestrator(a.projectId, `Loop detector: ${title}. ${detail}. Check on them with get_agent_status and redirect, or stop and reassign the quest with a sharper brief.`)
    }
  }
}

function signature(ev: ActivityEvent): string | undefined {
  switch (ev.kind) {
    case 'command': case 'test': return `cmd:${(ev.command?.cmd ?? ev.text).trim()}`
    case 'tool': return `tool:${ev.tool?.name ?? ''} ${ev.tool?.target ?? ev.text}`.trim()
    case 'edit': return `edit:${ev.edit?.path ?? ev.text} ${ev.edit?.hunk?.slice(0, 200) ?? ''}`
    default: return undefined
  }
}
