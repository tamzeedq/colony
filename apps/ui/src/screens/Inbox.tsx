import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { Alert, AlertKind } from '@/types/colony'
import { useStore } from '@/store/store'
import { AlertItem, KIND } from '@/components/alerts/AlertItem'
import { UndoSnackbar, useDismiss } from '@/components/alerts/dismiss'
import { KeyHint } from '@/components/ui/primitives'
import { ago, cx } from '@/lib/util'

const RANK: Record<AlertKind, number> = { crash: 0, host_down: 0, approval: 1, question: 2, loop: 3, budget: 4, limit_pace: 5 }

export function Inbox() {
  const { state, dispatch } = useStore()
  const loc = useLocation()
  const [filter, setFilter] = useState<AlertKind | 'all'>('all')
  const [showResolved, setShowResolved] = useState(false)
  const open = state.alerts.filter((a) => !a.resolvedAt).sort((a, b) => RANK[a.kind] - RANK[b.kind])
  const resolved = state.alerts.filter((a) => a.resolvedAt)
  const shown = open.filter((a) => filter === 'all' || a.kind === filter)
  const counted = open.filter((a) => a.severity !== 'heads_up')
  const kinds = Array.from(new Set(open.map((a) => a.kind)))
  const headsUps = open.filter((a) => a.severity === 'heads_up')
  const { dismiss, reopen } = useDismiss()
  const [focusId, setFocusId] = useState<string | undefined>()
  const [q, setQ] = useState('')
  const [baseF, setBaseF] = useState('all')
  const [kindF, setKindF] = useState<AlertKind | 'all'>('all')
  const past = useMemo(() => resolved
    .filter((a) => (baseF === 'all' || a.projectId === baseF) && (kindF === 'all' || a.kind === kindF)
      && (!q.trim() || `${a.title} ${a.detail ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '')), [resolved, baseF, kindF, q])
  const how = (a: Alert) => a.resolution === 'dismissed' ? 'you dismissed' : a.resolution === 'acted' ? 'you acted' : a.resolution === 'auto' ? 'auto-resolved' : 'resolved'

  // Keyboard: J/K move, A approve, R reply, E dismiss (same confirm rule as the button), Enter opens the agent.
  // Capture phase, so the global hotkeys (R = roster) don't also fire on this screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const key = e.key.toLowerCase()
      if (!['j', 'k', 'a', 'r', 'e', 'enter'].includes(key)) return
      if (key === 'enter' && t && (t.tagName === 'BUTTON' || t.tagName === 'A')) return
      const ids = shown.map((a) => a.id)
      if (!ids.length) return
      e.preventDefault(); e.stopPropagation()
      if (key === 'j' || key === 'k') {
        const i = focusId ? ids.indexOf(focusId) : -1
        const next = key === 'j' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)
        setFocusId(ids[next])
        document.getElementById(ids[next])?.scrollIntoView({ block: 'nearest' })
        return
      }
      const el = focusId ? document.getElementById(focusId) : null
      if (!el) return
      el.dispatchEvent(new CustomEvent(key === 'a' ? 'alert-approve' : key === 'r' ? 'alert-reply' : key === 'e' ? 'alert-dismiss' : 'alert-open'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [shown, focusId])

  useEffect(() => { if (loc.hash) document.getElementById(loc.hash.slice(1))?.scrollIntoView({ block: 'center' }) }, [loc.hash])

  return (
    <div className="flex flex-wrap">
      <main className="flex min-w-0 flex-[999_1_760px] flex-col gap-3.5 px-7 pb-7 pt-5.5">
        <div className="flex flex-wrap items-end gap-4">
          <div><div className="text-label mb-1.5">Inbox · ranked by urgency</div><h1 className="m-0 font-display text-[30px] font-semibold">{counted.length ? `${counted.length} thing${counted.length > 1 ? 's' : ''} need you` : 'All clear ◇'}</h1></div>
          <div className="flex-1" />
          <div role="tablist" className="flex flex-wrap gap-1">
            <button type="button" role="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')} className={cx('rounded-full px-3 py-1.5 text-xs', filter === 'all' ? 'bg-ink font-semibold text-ground' : 'border border-line text-ink-soft')}>All {open.length}</button>
            {kinds.map((k) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} className={cx('rounded-full px-3 py-1.5 text-xs', filter === k ? 'bg-ink font-semibold text-ground' : 'border border-line text-ink-soft')}>
                {KIND[k].g} {KIND[k].label.split(' · ')[0]} {open.filter((a) => a.kind === k).length}
              </button>
            ))}
          </div>
        </div>
        {headsUps.length > 0 && (
          <button type="button" onClick={() => dismiss(headsUps)} className="self-start rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft">Dismiss all heads-ups ({headsUps.length})</button>
        )}
        {shown.map((a) => <div key={a.id} onClick={() => setFocusId(a.id)}><AlertItem alert={a} focused={a.id === focusId} /></div>)}
        <button type="button" onClick={() => setShowResolved((v) => !v)} className="rounded-lg border border-dashed border-line py-2.5 text-[13px] text-ink-muted">✓ {resolved.length} dismissed or resolved ·{showResolved ? 'hide' : 'show'}</button>
        {showResolved && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dismissed..." aria-label="Search dismissed" className="min-w-[160px] flex-1 rounded-md border border-line bg-ground px-3 py-1.5 text-[13px]" />
              <select value={baseF} onChange={(e) => setBaseF(e.target.value)} aria-label="Base" className="rounded-md border border-line bg-ground px-2 py-1.5 text-xs">
                <option value="all">All bases</option>
                {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select value={kindF} onChange={(e) => setKindF(e.target.value as AlertKind | 'all')} aria-label="Kind" className="rounded-md border border-line bg-ground px-2 py-1.5 text-xs">
                <option value="all">All kinds</option>
                {(Object.keys(KIND) as AlertKind[]).map((k) => <option key={k} value={k}>{KIND[k].label.split(' · ')[0]}</option>)}
              </select>
            </div>
            {past.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-lg border border-line-soft px-4 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ink-muted">{a.title}</div>
                  <div className="text-[11px] text-ink-dim">{KIND[a.kind].label} · {state.projects.find((p) => p.id === a.projectId)?.name ?? 'no base'} · {a.resolvedAt ? ago(a.resolvedAt) : '?'} ago · {how(a)}</div>
                </div>
                <button type="button" onClick={() => reopen(a)} className="rounded-md border border-line px-2.5 py-1 text-xs">Reopen</button>
              </div>
            ))}
            {!past.length && <div className="text-xs text-ink-dim">Nothing matches. Resolved alerts are kept for 30 days.</div>}
          </div>
        )}
        <div className="text-xs text-ink-dim"><KeyHint>J / K</KeyHint> move · <KeyHint>A</KeyHint> approve · <KeyHint>R</KeyHint> reply · <KeyHint>E</KeyHint> dismiss · <KeyHint>↵</KeyHint> open agent</div>
      </main>
      <aside className="flex min-w-0 max-w-[480px] flex-[1_1_400px] flex-col gap-4 border-l border-line-soft bg-well px-5.5 py-5.5">
        <h2 className="text-section">How alerts reach you</h2>
        <div className="rounded-lg border border-line bg-surface p-3 text-[13px] leading-normal"><b className="text-st-error">Critical</b> (crash, Docker down): banner pinned under the HUD until resolved, plus a toast. <span className="text-ink-dim">Sound: two low knocks; repeats once after 60 s if unseen.</span></div>
        <div className="rounded-lg border border-line bg-surface p-3 text-[13px] leading-normal"><b className="text-st-you">Needs you</b> (approval, question, loop): toast top-right, max 2 stacked. 8 s timer drains, pauses on hover. <span className="text-ink-dim">Sound: soft rising chime.</span></div>
        <div className="rounded-lg border border-line bg-surface p-3 text-[13px] leading-normal"><b className="text-st-blocked">Heads-up</b> (limit pace, slow container): HUD and inbox only, never a toast. <span className="text-ink-dim">Sound: quiet tick, off by default.</span></div>
        <button type="button" onClick={() => dispatch({ type: 'mute' })} className="self-start rounded-md border border-line bg-raised px-3 py-1.5 text-xs">♪ Sound: {state.ui.muted ? 'off' : 'on'} · ⇧M</button>
      </aside>
      <UndoSnackbar />
    </div>
  )
}
