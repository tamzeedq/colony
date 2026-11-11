import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, needsYou, toastAlert, alertToasts } from '@/store/store'
import { useAlertAction } from './AlertItem'
import { cx } from '@/lib/util'
import { useAlertPrefs } from '@/lib/alertPrefs'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import type { AlertSeverity } from '@/types/colony'

const BANNER: Record<AlertSeverity, { bg: string; lead: string }> = {
  critical: { bg: 'bg-st-error', lead: '✕' },
  needs_you: { bg: 'bg-st-you', lead: '◆' },
  heads_up: { bg: 'bg-st-blocked', lead: '▲' },
}
const RANK: AlertSeverity[] = ['critical', 'needs_you', 'heads_up']

/**
 * Critical alerts pin a banner under the HUD until resolved (Settings → Alerts & sound can turn it
 * off, or turn banners on for needs-you / heads-up). A critical alert that arrives after load gives
 * the banner a single attention flash (skipped under reduced motion).
 */
export function CriticalBanner() {
  const { state } = useStore()
  const [prefs] = useAlertPrefs()
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const initial = useRef<Set<string> | null>(null)
  if (!initial.current) initial.current = new Set(state.alerts.map((a) => a.id))
  const [flashId, setFlashId] = useState<string>()

  const open = state.alerts.filter((a) => !a.resolvedAt && prefs.categories[a.severity].banner)
  const sev = RANK.find((r) => open.some((a) => a.severity === r))
  const list = sev ? open.filter((a) => a.severity === sev) : []
  const top = list[0]

  // Flash once for each new critical alert (never for the ones present at load).
  useEffect(() => {
    const fresh = state.alerts.filter((a) => a.severity === 'critical' && !a.resolvedAt && !initial.current!.has(a.id))
    fresh.forEach((a) => initial.current!.add(a.id))
    if (fresh.length && !reduced) setFlashId(fresh[0].id)
  }, [state.alerts, reduced])

  if (!top || !sev) return null
  const agent = state.agents.find((x) => x.id === top.agentId)
  const flash = !reduced && flashId !== undefined && sev === 'critical'
  return (
    <div key={flash ? flashId : 'banner'} role={sev === 'critical' ? 'alert' : 'status'}
      onAnimationEnd={() => setFlashId(undefined)}
      style={flash ? { animation: 'attention 1.6s ease-out 1' } : undefined}
      className={cx('relative z-[1] flex items-center gap-3 px-5 py-2 text-[13px] font-semibold text-[#1B0605]', BANNER[sev].bg)}>
      <span>{BANNER[sev].lead} {sev === 'critical' ? (agent ? `${agent.callsign} crashed` : 'Critical') : agent?.callsign ?? (sev === 'needs_you' ? 'Needs you' : 'Heads-up')} · {top.title}</span>
      {list.length > 1 && <span className="font-normal">+{list.length - 1} more</span>}
      <Link to={`/inbox#${top.id}`} className="ml-auto text-[#1B0605] underline">{sev === 'critical' ? 'Resolve' : 'Open'}</Link>
    </div>
  )
}

/** Needs-you alerts toast in, max 2 stacked, 8 s drain that pauses on hover. */
export function ToastStack() {
  const { state, dispatch, mode } = useStore()
  const act = useAlertAction()
  const seen = useRef(new Set(state.alerts.map((a) => a.id)))

  // New unresolved alerts become toasts (per Settings → Alerts & sound). Live mode toasts from the stream instead.
  useEffect(() => {
    if (mode !== 'mock') return
    for (const a of state.alerts) {
      if (seen.current.has(a.id)) continue
      seen.current.add(a.id)
      if (!a.resolvedAt && alertToasts(a.severity)) dispatch({ type: 'toast', toast: toastAlert(a) })
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
    : toast.tone === 'heads_up' ? { b: 'border-st-blocked/55', t: 'text-st-blocked', bar: 'bg-st-blocked', label: '▲ Heads-up' }
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
