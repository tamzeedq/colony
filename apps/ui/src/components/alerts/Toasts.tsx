import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, needsYou } from '@/store/store'
import { useAlertAction } from './AlertItem'
import { cx } from '@/lib/util'

/** Critical alerts pin a banner under the HUD until resolved. */
export function CriticalBanner() {
  const { state } = useStore()
  const crit = state.alerts.filter((a) => a.severity === 'critical' && !a.resolvedAt)
  if (!crit.length) return null
  const a = crit[0]
  const agent = state.agents.find((x) => x.id === a.agentId)
  return (
    <div role="alert" className="flex items-center gap-3 bg-st-error px-5 py-2 text-[13px] font-semibold text-[#1B0605]">
      <span>✕ {agent ? `${agent.callsign} crashed` : 'Critical'} · {a.title}</span>
      {crit.length > 1 && <span className="font-normal">+{crit.length - 1} more</span>}
      <Link to={`/inbox#${a.id}`} className="ml-auto text-[#1B0605] underline">Resolve</Link>
    </div>
  )
}

/** Needs-you alerts toast in, max 2 stacked, 8 s drain that pauses on hover. */
export function ToastStack() {
  const { state, dispatch, mode } = useStore()
  const act = useAlertAction()
  const seen = useRef(new Set(state.alerts.map((a) => a.id)))

  // New unresolved alerts (not heads-up) become toasts. Live mode toasts from the stream instead.
  useEffect(() => {
    if (mode !== 'mock') return
    for (const a of state.alerts) {
      if (seen.current.has(a.id)) continue
      seen.current.add(a.id)
      if (!a.resolvedAt && a.severity !== 'heads_up') dispatch({ type: 'toast', toast: { id: a.id, alertId: a.id, title: a.title, tone: a.severity === 'critical' ? 'critical' : 'needs_you', at: Date.now() } })
    }
  }, [state.alerts, dispatch, mode])

  // Demo (mock only): an agent asks a question 25 s after load.
  useEffect(() => {
    if (mode !== 'mock') return
    const t = setTimeout(() => dispatch({ type: 'addAlert', alert: {
      id: 'a-demo-q', at: new Date().toISOString(), kind: 'question', severity: 'needs_you', projectId: 'p-readable', agentId: 'mira-12',
      title: 'Send reminder emails at 7pm local time, or let readers pick a time?',
      actions: [{ id: 'reply:7pm local', label: '7pm local' }, { id: 'reply:Let readers pick', label: 'Let readers pick' }],
    } }), 25000)
    return () => clearTimeout(t)
  }, [dispatch, mode])

  const toasts = state.ui.toasts.slice(-2)
  const extra = needsYou(state).length - toasts.filter((t) => t.alertId).length
  return (
    <div className="pointer-events-none fixed right-4 top-20 z-[60] flex w-[300px] flex-col gap-2.5">
      {toasts.map((t) => <ToastCard key={t.id} toast={t} onDone={() => dispatch({ type: 'dismissToast', id: t.id })}
        onPrimary={() => { const a = state.alerts.find((x) => x.id === t.alertId); if (a) act(a, a.actions[0].id) }}
        primaryLabel={state.alerts.find((x) => x.id === t.alertId)?.actions[0]?.label} />)}
      {toasts.length > 0 && extra > 0 && (
        <Link to="/inbox" className="pointer-events-auto rounded-lg border border-line bg-raised px-3 py-2 text-xs text-ink-muted shadow-raised no-underline">+ {extra} more · open inbox</Link>
      )}
    </div>
  )
}

function ToastCard({ toast, onDone, onPrimary, primaryLabel }: { toast: { id: string; title: string; tone: string }; onDone: () => void; onPrimary: () => void; primaryLabel?: string }) {
  const [paused, setPaused] = useState(false)
  const [left, setLeft] = useState(8000)
  useEffect(() => {
    if (paused) return
    const start = Date.now(), from = left
    const id = setInterval(() => {
      const l = from - (Date.now() - start)
      setLeft(l)
      if (l <= 0) { clearInterval(id); onDone() }
    }, 100)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused])
  const tone = toast.tone === 'critical' ? { b: 'border-st-error/60', t: 'text-st-error', bar: 'bg-st-error', label: '✕ Critical' }
    : toast.tone === 'done' ? { b: 'border-st-done/50', t: 'text-st-done', bar: 'bg-st-done', label: '✓ Done' }
    : toast.tone === 'error' ? { b: 'border-st-error/60', t: 'text-st-error', bar: 'bg-st-error', label: '✕ Didn’t go through' }
    : { b: 'border-st-you/55', t: 'text-st-you', bar: 'bg-st-you', label: '◆ Needs you' }
  return (
    <div role="status" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      className={cx('pointer-events-auto animate-pop overflow-hidden rounded-lg border bg-raised shadow-raised', tone.b)}>
      <div className="px-3 py-2.5">
        <div className={cx('text-[11px] font-bold uppercase tracking-[.08em]', tone.t)}>{tone.label}</div>
        <div className="mt-1 text-[13px] leading-snug">{toast.title}</div>
        <div className="mt-2 flex gap-1.5">
          {primaryLabel && <button type="button" onClick={onPrimary} className="rounded-sm bg-you px-2.5 py-1 text-xs font-semibold text-you-ink">{primaryLabel}</button>}
          <button type="button" onClick={onDone} className="rounded-sm border border-line-strong px-2.5 py-1 text-xs">Dismiss</button>
          <span className="ml-auto self-center font-mono text-[10px] text-ink-dim">G A</span>
        </div>
      </div>
      <div className="h-[3px] bg-line"><div className={cx('h-full', tone.bar)} style={{ width: `${Math.max(0, left / 80)}%` }} /></div>
    </div>
  )
}
