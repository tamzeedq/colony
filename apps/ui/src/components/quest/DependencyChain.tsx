// Quest dependency chain (feedback #9). Cards flow in depth columns and wrap instead of scrolling
// inside a fixed-height box; on narrow screens the columns stack vertically. Connectors are drawn
// over the laid-out cards (measured), dashed + marching while live, solid once settled.
import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Quest } from '@/types/colony'
import { QUEST_STATUS } from '@/design/status'
import { useStore, mergeRequestForQuest, reviewHref } from '@/store/store'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cx } from '@/lib/util'

function columns(focus: Quest, all: Quest[]) {
  const byId = new Map(all.map((q) => [q.id, q]))
  const ups: Quest[] = []
  const collectUp = (q: Quest) => q.dependsOn.forEach((id) => { const d = byId.get(id); if (d && !ups.includes(d)) { ups.push(d); collectUp(d) } })
  collectUp(focus)
  const downs = all.filter((q) => q.dependsOn.includes(focus.id))
  const downs2 = all.filter((q) => !downs.includes(q) && q.id !== focus.id && downs.some((d) => q.dependsOn.includes(d.id)))
  const cols = [ups, [focus], downs, downs2].filter((c) => c.length)
  const shown = new Set(cols.flat().map((q) => q.id))
  const edges = cols.flat().flatMap((q) => q.dependsOn.filter((d) => shown.has(d))
    .map((d) => ({ from: d, to: q.id, live: byId.get(d)?.status !== 'done' || q.status === 'in_progress' })))
  return { cols, edges }
}

type Line = { x1: number; y1: number; x2: number; y2: number; live: boolean }

export function DependencyChain({ quest, quests }: { quest: Quest; quests: Quest[] }) {
  const { state, mode } = useStore()
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const { cols, edges } = columns(quest, quests)
  const box = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState<Line[]>([])
  const name = (aid?: string) => state.agents.find((a) => a.id === aid)?.callsign ?? (aid === 'you' ? 'You' : aid)
  const edgeKey = edges.map((e) => `${e.from}>${e.to}:${e.live ? 1 : 0}`).join(',')

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const o = el.getBoundingClientRect()
      const rect = (id: string) => el.querySelector<HTMLElement>(`[data-quest="${CSS.escape(id)}"]`)?.getBoundingClientRect()
      const next: Line[] = []
      for (const e of edges) {
        const a = rect(e.from), b = rect(e.to)
        if (!a || !b) continue
        // Side by side → right edge to left edge; stacked → bottom to top.
        if (b.left >= a.right - 1) next.push({ x1: a.right - o.left, y1: a.top + a.height / 2 - o.top, x2: b.left - o.left, y2: b.top + b.height / 2 - o.top, live: e.live })
        else if (b.top >= a.bottom - 1) next.push({ x1: a.left + a.width / 2 - o.left, y1: a.bottom - o.top, x2: b.left + b.width / 2 - o.left, y2: b.top - o.top, live: e.live })
      }
      setLines(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeKey, quest.id])

  return (
    <div ref={box} className="relative">
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {lines.map((l, i) => (
          <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} strokeWidth={2}
            className={l.live ? 'stroke-st-run' : 'stroke-line-strong'} strokeDasharray={l.live ? '5 7' : undefined}>
            {l.live && !reduced && <animate attributeName="stroke-dashoffset" from="24" to="0" dur="1.4s" repeatCount="indefinite" />}
          </line>
        ))}
      </svg>
      <div className="relative flex flex-col items-center gap-6 md:flex-row md:flex-wrap md:items-center md:justify-center md:gap-x-12 md:gap-y-6">
        {cols.map((c, ci) => (
          <div key={ci} className="flex w-full flex-col gap-3 md:w-[220px]">
            {c.map((q) => {
              const s = QUEST_STATUS[q.status]
              const self = q.id === quest.id
              const review = q.status === 'in_review' ? reviewHref(mode, mergeRequestForQuest(state, q), q) : undefined
              return (
                <div key={q.id} data-quest={q.id}
                  className={cx('relative rounded-lg border border-l-4 bg-surface px-3 py-2 hover:border-line-strong', self ? 'border-you ring-1 ring-you' : 'border-line')}
                  style={{ borderLeftColor: `var(--color-${s.text.replace('text-', '')})` }}>
                  <div className={cx('text-[11px] font-semibold', s.text)}>{s.glyph} {s.label}</div>
                  <Link to={`/quest/${q.id}`} title={q.title} aria-current={self ? 'page' : undefined}
                    className="mt-0.5 line-clamp-3 text-[13px] font-medium leading-snug text-ink no-underline after:absolute after:inset-0 after:content-['']">
                    {q.title}
                  </Link>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-dim">
                    <span className="truncate">{self ? 'this quest' : name(q.assigneeId) ?? 'unassigned'}</span>
                    {review && <Link to={review} className="relative z-[1] ml-auto shrink-0 font-semibold text-you no-underline">Review →</Link>}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
