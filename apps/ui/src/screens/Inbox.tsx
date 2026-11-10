import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { AlertKind } from '@/types/colony'
import { useStore } from '@/store/store'
import { AlertItem, KIND } from '@/components/alerts/AlertItem'
import { KeyHint } from '@/components/ui/primitives'
import { cx } from '@/lib/util'

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
        {shown.map((a) => <AlertItem key={a.id} alert={a} />)}
        <button type="button" onClick={() => setShowResolved((v) => !v)} className="rounded-lg border border-dashed border-line py-2.5 text-[13px] text-ink-muted">✓ {resolved.length} resolved · {showResolved ? 'hide' : 'show'}</button>
        {showResolved && resolved.map((a) => <div key={a.id} className="rounded-lg border border-line-soft px-4 py-2.5 text-[13px] text-ink-dim line-through decoration-ink-dim/50">{a.title}</div>)}
        <div className="text-xs text-ink-dim"><KeyHint>J / K</KeyHint> move · <KeyHint>A</KeyHint> approve · <KeyHint>R</KeyHint> reply · <KeyHint>E</KeyHint> dismiss · <KeyHint>↵</KeyHint> open agent</div>
      </main>
      <aside className="flex min-w-0 max-w-[480px] flex-[1_1_400px] flex-col gap-4 border-l border-line-soft bg-well px-5.5 py-5.5">
        <h2 className="text-section">How alerts reach you</h2>
        <div className="rounded-lg border border-line bg-surface p-3 text-[13px] leading-normal"><b className="text-st-error">Critical</b> (crash, Docker down): banner pinned under the HUD until resolved, plus a toast. <span className="text-ink-dim">Sound: two low knocks; repeats once after 60 s if unseen.</span></div>
        <div className="rounded-lg border border-line bg-surface p-3 text-[13px] leading-normal"><b className="text-st-you">Needs you</b> (approval, question, loop): toast top-right, max 2 stacked. 8 s timer drains, pauses on hover. <span className="text-ink-dim">Sound: soft rising chime.</span></div>
        <div className="rounded-lg border border-line bg-surface p-3 text-[13px] leading-normal"><b className="text-st-blocked">Heads-up</b> (limit pace, slow container): HUD and inbox only, never a toast. <span className="text-ink-dim">Sound: quiet tick, off by default.</span></div>
        <button type="button" onClick={() => dispatch({ type: 'mute' })} className="self-start rounded-md border border-line bg-raised px-3 py-1.5 text-xs">♪ Sound: {state.ui.muted ? 'off' : 'on'} · ⇧M</button>
      </aside>
    </div>
  )
}
