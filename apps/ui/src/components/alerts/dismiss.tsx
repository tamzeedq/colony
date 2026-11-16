// Dismissing Inbox alerts safely (feedback item 17): confirm the important ones, always offer Undo.
import { useCallback, useSyncExternalStore } from 'react'
import type { Alert, Agent } from '@/types/colony'
import { useStore } from '@/store/store'

/** Heads-ups dismiss in one click; needs-you and critical alerts ask first. */
export const needsConfirm = (a: Alert) => a.severity !== 'heads_up'

/** What stays undone if this alert is dismissed (shown while confirming). */
export function leftUndone(a: Alert, agent?: Agent): string {
  const who = agent?.callsign ?? 'The agent'
  switch (a.kind) {
    case 'approval': return 'The merge stays pending and is still in Merge Review and on the quest page.'
    case 'question': return `${who} is still waiting for an answer.`
    case 'crash': case 'host_down': return a.severity === 'heads_up' ? '' : `${who} stays stopped.`
    case 'loop': return `${who} keeps looping until you step in.`
    case 'budget': return 'The daily cap is unchanged.'
    default: return 'Nothing is changed by dismissing.'
  }
}

// ── Undo snackbar: a tiny external store so any card (Inbox, base page) can raise it ──
interface Snack { id: number; text: string; undo: () => void }
let snack: Snack | null = null
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined
const subs = new Set<() => void>()
const notify = () => subs.forEach((f) => f())
export function showSnack(text: string, undo: () => void, ms = 8000) {
  snack = { id: ++seq, text, undo }
  clearTimeout(timer)
  timer = setTimeout(() => { snack = null; notify() }, ms)
  notify()
}
export function clearSnack() { clearTimeout(timer); snack = null; notify() }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export function UndoSnackbar() {
  const s = useSyncExternalStore(subscribe, () => snack)
  if (!s) return null
  return (
    <div role="status" className="pointer-events-auto fixed bottom-5 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-raised px-4 py-2.5 text-[13px] shadow-raised">
      <span>{s.text}</span>
      <button type="button" onClick={() => { s.undo(); clearSnack() }} className="rounded-sm bg-ink px-2.5 py-1 text-xs font-semibold text-ground">Undo</button>
    </div>
  )
}

/** Dismiss one or many alerts and offer Undo (which reopens them). */
export function useDismiss() {
  const { dispatch } = useStore()
  const dismiss = useCallback((alerts: Alert[]) => {
    if (!alerts.length) return
    for (const a of alerts) void dispatch({ type: 'resolveAlert', id: a.id, resolution: 'dismissed' })
    showSnack(alerts.length === 1 ? 'Dismissed' : `Dismissed ${alerts.length} heads-ups`, () => { for (const a of alerts) void dispatch({ type: 'reopenAlert', id: a.id }) })
  }, [dispatch])
  const reopen = useCallback((a: Alert) => { void dispatch({ type: 'reopenAlert', id: a.id }) }, [dispatch])
  return { dismiss, reopen }
}
