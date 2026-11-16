// Pause / resume controls (feedback #18): one place for what "Pause all" and "Pause base" do.
//
// A pause is a request: agents show "pausing" until their runner reports `paused` (they stop after
// the current step). This module derives the button state from the agents, runs the 3-second
// countdown for Pause all, tracks the progress of the last pause (for the "Paused 5 · Undo" bar),
// and drives "Shut down Colony". It lives outside React state so the HUD button, the Base page,
// ⇧Space and the command palette all share it.
import { useSyncExternalStore } from 'react'
import type { Agent, ID } from '@/types/colony'
import type { Action, State } from './reducer'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'

export type PauseScope = { kind: 'all' } | { kind: 'base'; projectId: ID; name: string }
type Reason = NonNullable<Agent['pausedBy']>

export const COUNTDOWN_MS = 3000
const PAUSE_TIMEOUT_MS = 20_000

export interface Countdown { scope: PauseScope; workersOnly: boolean; endsAt: number }
export interface PauseOp {
  seq: number
  scope: PauseScope
  workersOnly: boolean
  ids: ID[]
  /** Agents in scope that cannot be paused (crashed). */
  skipped: ID[]
  startedAt: number
  phase: 'pausing' | 'done' | 'partial'
  /** Targets that were still not paused after the timeout. */
  failed: ID[]
  /** Set when Undo / Resume ran. */
  resumed?: boolean
}
export type ShutdownPhase = null | 'confirm' | 'working' | 'error' | 'done'
export interface PauseUi { countdown?: Countdown; op?: PauseOp; shutdown: ShutdownPhase; shutdownSteps: string[]; shutdownError?: string }

// ── tiny external store ──
let ui: PauseUi = { shutdown: null, shutdownSteps: [] }
const subs = new Set<() => void>()
const setUi = (p: Partial<PauseUi>) => { ui = { ...ui, ...p }; subs.forEach((f) => f()) }
export const usePauseUi = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => ui)

// ── latest app state, bound by <PauseEffects/> on every render ──
interface Bound { state: State; dispatch: (a: Action) => Promise<boolean>; mode: 'mock' | 'live' }
let bound: Bound | null = null
export const bindPause = (b: Bound) => { bound = b }

// ── derived views ──
export const isLiveAgent = (a: Agent) => a.status !== 'error' && a.status !== 'done'
export const isPausing = (a: Agent) => !!a.pauseRequested && a.status !== 'paused'
export const isPaused = (a: Agent) => a.status === 'paused'
export const isMidTask = (a: Agent) => a.status === 'running' || a.status === 'thinking' || a.status === 'editing'
const reasonOf = (a: Agent): Reason => a.pausedBy ?? 'you'
const byYou = (a: Agent) => reasonOf(a) === 'you'

export const scopeAgents = (state: State, scope: PauseScope, workersOnly = false) =>
  state.agents.filter((a) => (scope.kind === 'all' || a.projectId === scope.projectId) && !(workersOnly && a.role === 'orchestrator'))

export const REASON_LABEL: Record<Reason, string> = { you: 'Paused by you', budget: 'Agent budget cap', plan_usage: 'Plan limit', project_budget: 'Project budget' }

export interface PauseView {
  mode: 'pause' | 'resume' | 'limits-only' | 'none'
  live: number
  /** Live agents not paused and not pausing. */
  running: number
  pausing: number
  paused: number
  pausedByYou: number
  pausedByLimits: number
  /** Progress of the pause in flight for this scope. */
  progress?: { done: number; total: number }
}

export function pauseView(state: State, scope: PauseScope, op?: PauseOp): PauseView {
  const ag = scopeAgents(state, scope).filter(isLiveAgent)
  const paused = ag.filter(isPaused)
  const pausing = ag.filter(isPausing)
  const running = ag.length - paused.length - pausing.length
  const pausedByYou = paused.filter(byYou).length
  const pausedByLimits = paused.length - pausedByYou
  const mode: PauseView['mode'] = !ag.length ? 'none'
    : paused.length === ag.length ? (pausedByYou ? 'resume' : 'limits-only') : 'pause'
  let progress: PauseView['progress']
  if (op && op.phase === 'pausing' && sameScope(op.scope, scope)) {
    const done = op.ids.filter((id) => state.agents.find((a) => a.id === id)?.status === 'paused').length
    progress = { done, total: op.ids.length }
  }
  return { mode, live: ag.length, running, pausing: pausing.length, paused: paused.length, pausedByYou, pausedByLimits, progress }
}
const sameScope = (a: PauseScope, b: PauseScope) => a.kind === b.kind && (a.kind === 'all' || (b.kind === 'base' && a.projectId === b.projectId))

export function pausedGroups(state: State): { reason: Reason; agents: Agent[] }[] {
  const paused = state.agents.filter((a) => isLiveAgent(a) && isPaused(a))
  return (['you', 'plan_usage', 'budget', 'project_budget'] as Reason[])
    .map((reason) => ({ reason, agents: paused.filter((a) => reasonOf(a) === reason) }))
    .filter((g) => g.agents.length)
}

const names = (state: State, ids: ID[]) => ids.map((id) => state.agents.find((a) => a.id === id)?.callsign ?? id).join(', ')
const plural = (n: number, w = 'agent') => `${n} ${w}${n === 1 ? '' : 's'}`
let toastSeq = 0
function toast(title: string, tone: 'done' | 'error' | 'heads_up' = 'done') {
  bound?.dispatch({ type: 'toast', toast: { id: `pause-${Date.now()}-${toastSeq++}`, title, tone, at: Date.now() } })
}

// ── actions ──
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

/** Pause a scope. Pause all asks first (3-second countdown) when anyone is mid-task; Pause base never does. */
export function requestPause(scope: PauseScope, workersOnly = false) {
  if (!bound) return
  if (ui.countdown) { runPause(ui.countdown.scope, ui.countdown.workersOnly); return } // pressing again = pause now
  const targets = scopeAgents(bound.state, scope, workersOnly).filter((a) => isLiveAgent(a) && !isPaused(a) && !isPausing(a))
  if (!targets.length) { toast('Nothing to pause: everyone is already paused or pausing.', 'heads_up'); return }
  if (scope.kind === 'all' && targets.some(isMidTask)) {
    clearTimeout(timer)
    setUi({ countdown: { scope, workersOnly, endsAt: Date.now() + COUNTDOWN_MS } })
    timer = setTimeout(() => { if (ui.countdown) runPause(ui.countdown.scope, ui.countdown.workersOnly) }, COUNTDOWN_MS)
    return
  }
  runPause(scope, workersOnly)
}

export function cancelCountdown() { clearTimeout(timer); setUi({ countdown: undefined }) }

function runPause(scope: PauseScope, workersOnly: boolean) {
  if (!bound) return
  clearTimeout(timer)
  const { state, dispatch } = bound
  const inScope = scopeAgents(state, scope, workersOnly)
  const targets = inScope.filter((a) => isLiveAgent(a) && !isPaused(a) && !isPausing(a))
  const op: PauseOp = {
    seq: ++seq, scope, workersOnly, ids: targets.map((a) => a.id), skipped: inScope.filter((a) => a.status === 'error').map((a) => a.id),
    startedAt: Date.now(), phase: 'pausing', failed: [],
  }
  setUi({ countdown: undefined, op: targets.length ? op : undefined })
  if (!targets.length) return
  void dispatch(scope.kind === 'all' ? { type: 'pauseAll', workersOnly } : { type: 'pause', ids: op.ids }).then((ok) => {
    if (!ok && ui.op?.seq === op.seq) setUi({ op: undefined }) // the store already toasted the failure
  })
}

/** Resume what you paused. `includeLimits` also resumes agents paused by a budget or plan limit (they may pause again). */
export function resumeScope(scope: PauseScope, includeLimits = false) {
  if (!bound) return
  const { state, dispatch } = bound
  const ids = scopeAgents(state, scope).filter((a) => (isPaused(a) || isPausing(a)) && (includeLimits || byYou(a))).map((a) => a.id)
  if (!ids.length) return
  setUi({ op: undefined })
  void dispatch({ type: 'resume', ids }).then((ok) => { if (ok) toast(`Resumed ${plural(ids.length)}.`) })
}

export function resumeAgents(ids: ID[]) {
  if (!bound || !ids.length) return
  void bound.dispatch({ type: 'resume', ids })
}

/** ⇧Space and the palette: pause everything, or resume what you paused. */
export function togglePauseAll() {
  if (!bound) return
  const v = pauseView(bound.state, { kind: 'all' }, ui.op)
  if (v.mode === 'resume') resumeScope({ kind: 'all' })
  else if (v.mode === 'pause') requestPause({ kind: 'all' })
}

export function undoPause() {
  if (!bound || !ui.op) return
  const op = ui.op
  const ids = op.ids.filter((id) => { const a = bound!.state.agents.find((x) => x.id === id); return !!a && (isPaused(a) || isPausing(a)) })
  setUi({ op: undefined })
  if (ids.length) void bound.dispatch({ type: 'resume', ids }).then((ok) => { if (ok) toast(`Resumed ${plural(ids.length)}.`) })
}
export const dismissOp = () => setUi({ op: undefined })

/** Called by <PauseEffects/> whenever agents change: finishes or times out the pause in flight. */
export function trackPause(state: State) {
  const op = ui.op
  if (!op || op.phase !== 'pausing') return
  const agents = op.ids.map((id) => state.agents.find((a) => a.id === id))
  const settled = agents.filter((a) => !a || a.status === 'paused')
  const broke = agents.filter((a): a is Agent => !!a && (a.status === 'error' || a.status === 'done'))
  const waiting = agents.length - settled.length - broke.length
  const timedOut = Date.now() - op.startedAt > PAUSE_TIMEOUT_MS
  if (waiting > 0 && !timedOut) return
  const failed = [...broke.map((a) => a.id), ...agents.filter((a): a is Agent => !!a && a.status !== 'paused' && !broke.includes(a)).map((a) => a.id)]
  setUi({ op: { ...op, phase: failed.length ? 'partial' : 'done', failed } })
  if (failed.length) toast(`Couldn't pause ${names(state, failed)}: still not reporting paused (disconnected or crashed?). The pause stays requested and applies when it reconnects.`, 'error')
}

export function opSummary(state: State, op: PauseOp): string {
  const scope = op.scope.kind === 'base' ? ` in ${op.scope.name}` : ''
  const paused = op.ids.filter((id) => state.agents.find((a) => a.id === id)?.status === 'paused').length
  const skipped = op.skipped.length ? ` · ${op.skipped.length} crashed, not paused (${names(state, op.skipped)})` : ''
  if (op.phase === 'pausing') return `Pausing${scope}… ${paused} of ${op.ids.length}`
  if (op.phase === 'partial') return `Paused ${paused} of ${plural(op.ids.length)}${scope} · couldn't pause ${names(state, op.failed)}${skipped}`
  return `Paused ${plural(op.ids.length)}${scope}${skipped}`
}

// ── shutdown ──
export const openShutdown = () => setUi({ shutdown: 'confirm', shutdownSteps: [], shutdownError: undefined })
export const closeShutdown = () => { if (ui.shutdown !== 'working') setUi({ shutdown: null }) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Pause all → stop dev Supabase stacks → ask the control plane to exit. Containers are left as they are. */
export async function runShutdown() {
  if (!bound || ui.shutdown === 'working') return
  const live = bound.mode === 'live'
  const steps: string[] = []
  const step = (s: string) => { steps.push(s); setUi({ shutdownSteps: [...steps] }) }
  setUi({ shutdown: 'working', shutdownSteps: [], shutdownError: undefined })
  try {
    step('Pausing all agents…')
    if (live) await endpoints.pauseAll()
    else await sleep(500)
    // Let agents finish their current step (up to 10 s).
    for (let i = 0; i < 20 && bound.state.agents.some((a) => isLiveAgent(a) && isPausing(a)) && live; i++) await sleep(500)

    const stacks = bound.state.projects.filter((p) => p.supabase.status === 'running' || p.supabase.status === 'provisioning' || p.supabase.status === 'error')
    if (stacks.length) step(`Stopping dev Supabase for ${stacks.map((p) => p.name).join(', ')}…`)
    if (live) {
      for (const p of stacks) {
        try { await endpoints.supabaseAction(p.id, 'stop') } catch { /* already stopped */ }
      }
      for (let i = 0; i < 60 && stacks.length; i++) {
        const d = await Promise.all(stacks.map((p) => endpoints.supabaseDetails(p.id).catch(() => undefined)))
        if (d.every((x) => !x || x.status === 'stopped' || x.status === 'none' || x.status === 'error')) break
        await sleep(1000)
      }
    } else if (stacks.length) await sleep(600)

    step('Shutting down the control plane…')
    if (live) await endpoints.shutdown()
    else await sleep(500)
    setUi({ shutdown: 'done' })
  } catch (e) {
    setUi({ shutdown: 'error', shutdownError: errorMessage(e) })
  }
}
