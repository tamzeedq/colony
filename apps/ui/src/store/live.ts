// Live mode: UI action → control-plane call (docs/phase2.md "UI action → API").
// The reducer has already applied the optimistic update; the stream is the source of truth
// and corrects it. Returns null for actions that stay local (UI state, toasts, quests).
import type { Action, State } from './reducer'
import { endpoints, mergeRequestFrom } from '@/api/endpoints'
import type { Guards } from '@/types/colony'

export interface LiveEffect {
  /** API work for the action. */
  run: () => Promise<unknown>
  /** Follow-up local actions from the response (e.g. the updated merge request). */
  then?: (result: unknown) => Action[]
  label: string
}

const each = (ids: string[], f: (id: string) => Promise<unknown>) => Promise.all(ids.map(f))

export function liveEffect(a: Action, prev: State): LiveEffect | null {
  switch (a.type) {
    case 'pause': return { label: 'Pause', run: () => each(a.ids, endpoints.pause) }
    case 'resume': return { label: 'Resume', run: () => each(a.ids, endpoints.resume) }
    case 'pauseAll': return { label: 'Pause all', run: endpoints.pauseAll }
    case 'kill': return { label: 'Kill', run: () => each(a.ids, endpoints.kill) }
    case 'restart': return { label: 'Restart', run: () => endpoints.restart(a.id) }
    case 'setModel': return { label: 'Change model', run: () => endpoints.patchAgent(a.id, { model: a.model }) }
    case 'configAgent': return { label: 'Save config', run: () => endpoints.patchAgent(a.id, { rolePrompt: a.rolePrompt, budgetCapUsd: a.budgetCapUsd }) }
    case 'takeControl': return { label: 'Take control', run: () => endpoints.takeControl(a.id) }
    case 'handBack': return { label: 'Hand back', run: () => endpoints.handBack(a.id, a.note) }
    case 'message': return { label: 'Message', run: () => endpoints.message(a.id, a.text) }
    case 'resolveAlert': return { label: 'Resolve alert', run: () => endpoints.resolveAlert(a.id) }
    case 'setGoal': return { label: 'Send goal', run: () => endpoints.patchProject(a.projectId, { goal: a.goal }) }
    case 'cap': return { label: 'Daily cap', run: () => endpoints.patchProject(a.projectId, { dailyCapUsd: a.cap }) }
    case 'guards': return { label: 'Guards', run: () => queueGuards(a.patch) }
    case 'approveMerge': return {
      label: 'Approve & merge', run: () => endpoints.approveMerge(a.id),
      then: (r) => { const mr = mergeRequestFrom(r); return mr ? [{ type: 'upsertMergeRequest', mergeRequest: mr }] : [] },
    }
    case 'requestChanges': return {
      label: 'Request changes', run: () => endpoints.requestChanges(a.id, a.note),
      then: (r) => { const mr = mergeRequestFrom(r); return mr ? [{ type: 'upsertMergeRequest', mergeRequest: mr }] : [] },
    }
    case 'downshift': {
      // Expanded by the store into setModel per worker; nothing to call for the batch itself.
      const ids = prev.agents.filter((x) => x.role !== 'orchestrator' && x.status !== 'waiting' && x.model !== 'haiku-5.5').map((x) => x.id)
      return { label: 'Downshift', run: () => each(ids, (id) => endpoints.patchAgent(id, { model: 'haiku-5.5' })) }
    }
    default: return null
  }
}

// Guards sliders fire on every tick: coalesce patches and send one PATCH after a short pause.
let pending: Partial<Guards> = {}
let timer: ReturnType<typeof setTimeout> | undefined
let waiters: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []

function queueGuards(patch: Partial<Guards>): Promise<unknown> {
  // `autoDownshiftAtPct: undefined` means "off"; send null so it survives JSON.
  pending = { ...pending, ...patch }
  clearTimeout(timer)
  return new Promise((resolve, reject) => {
    waiters.push({ resolve, reject })
    timer = setTimeout(() => {
      const body = Object.fromEntries(Object.entries(pending).map(([k, v]) => [k, v === undefined ? null : v])) as Partial<Guards>
      const ws = waiters
      pending = {}; waiters = []
      endpoints.patchGuards(body).then((r) => ws.forEach((w) => w.resolve(r)), (e) => ws.forEach((w, i) => (i === 0 ? w.reject(e) : w.resolve(undefined))))
    }, 350)
  })
}
