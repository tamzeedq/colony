import { useMemo } from 'react'
import type { ActivityEvent, ActivityKind } from '@/types/colony'
import { useStore } from '@/store/store'
import { useThrottledStream, type FeedItem } from '@/hooks/useThrottledStream'
import { ago, cx } from '@/lib/util'

const KIND: Record<ActivityKind, { g: string; cls: string }> = {
  thought: { g: '⋯', cls: 'bg-st-think/14 text-st-think' },
  tool: { g: '▸', cls: 'bg-raised text-ink-soft' },
  command: { g: '›', cls: 'bg-st-run/14 text-st-run' },
  edit: { g: '✎', cls: 'bg-st-run/14 text-st-run' },
  test: { g: '✓', cls: 'bg-st-done/14 text-st-done' },
  message: { g: '⇢', cls: 'bg-st-think/14 text-st-think' },
  handoff: { g: '⇢', cls: 'bg-st-think/14 text-st-think' },
  status: { g: '!', cls: 'bg-st-you/14 text-st-you' },
  quest_complete: { g: '✓', cls: 'bg-st-done/14 text-st-done' },
}

export function FeedIcon({ kind }: { kind: ActivityKind }) {
  const k = KIND[kind]
  return <span aria-hidden="true" className={cx('grid h-[18px] w-[18px] shrink-0 place-items-center rounded-xs font-mono text-[10px]', k.cls)}>{k.g}</span>
}

export function FeedRow({ e, who, showTime = true }: { e: FeedItem; who: string; showTime?: boolean }) {
  const text = e.groupCount && e.groupCount > 1
    ? `${e.kind === 'edit' ? 'edited' : 'ran'} ${e.groupCount} ${e.kind === 'edit' ? 'files' : 'tool calls'} · latest ${e.text}`
    : e.text
  return (
    <div className="flex items-start gap-2 border-b border-line-soft/70 py-1.5 text-xs leading-[1.45]">
      <FeedIcon kind={e.kind} />
      <div className="min-w-0 flex-1">
        <b className="font-semibold">{who}</b>{' '}
        <span className={cx('text-ink-soft', e.kind === 'thought' && 'italic text-[#C9C0FA]', (e.kind === 'command' || e.kind === 'tool') && 'font-mono')}>{text}</span>
      </div>
      {showTime && <span className="shrink-0 font-mono text-[10px] text-ink-dim">{ago(e.at)}</span>}
    </div>
  )
}

export function ActivityFeed({ filter, limit = 10, title = 'Activity' }: { filter?: (e: ActivityEvent) => boolean; limit?: number; title?: string }) {
  const { state, subscribe, seedEvents } = useStore()
  const { items, pending, hold, release } = useThrottledStream(subscribe, { initial: seedEvents, filter })
  const names = useMemo(() => Object.fromEntries(state.agents.map((a) => [a.id, a.callsign])), [state.agents])
  const rows = items.slice(-limit).reverse()
  return (
    <section aria-label={title} onMouseEnter={hold} onMouseLeave={release}>
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="text-section">{title}</h2>
        <span className="h-[7px] w-[7px] animate-breathe rounded-full bg-st-run" />
        <span className="ml-auto text-[11px] text-ink-dim">throttled · 2 Hz</span>
      </div>
      {pending > 0 && (
        <button type="button" onClick={release}
          className="mb-2 w-full rounded-sm border border-dashed border-st-run/40 bg-st-run/8 py-1.5 text-xs text-st-run">
          ↑ {pending} new events while you hovered
        </button>
      )}
      <div aria-live="off">
        {rows.map((e) => <FeedRow key={e.id} e={e} who={names[e.agentId] ?? e.agentId} />)}
      </div>
    </section>
  )
}
