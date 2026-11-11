// Settings → Spend & usage (docs/phase6.md §4): totals, a daily spend bar chart, breakdowns by
// base / role / model and the control plane's savings recommendations.
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/store/store'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { mockAnalytics } from '@/data/analyticsMock'
import { cx, usd } from '@/lib/util'
import type { Analytics, AnalyticsDays, Recommendation, UsageTotals } from '@/types/colony'

const card = 'rounded-xl border border-line bg-surface px-5 py-4.5'
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const ROLE_LABEL: Record<string, string> = {
  orchestrator: 'Orchestrator', frontend: 'Frontend', backend: 'Backend', qa: 'QA', devops: 'DevOps', researcher: 'Researcher', custom: 'Custom', unknown: 'Unknown',
}
const dayLabel = (day: string, long = false) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' })

export function SpendUsage() {
  const { state, mode } = useStore()
  const [days, setDays] = useState<AnalyticsDays>(7)
  const [live, setLive] = useState<{ days: AnalyticsDays; data?: Analytics; error?: string } | null>(null)

  useEffect(() => {
    if (mode !== 'live') return
    let gone = false
    setLive((l) => (l && l.days === days ? l : { days }))
    endpoints.analytics(days).then(
      (data) => { if (!gone) setLive({ days, data }) },
      (e) => { if (!gone) setLive({ days, error: errorMessage(e) }) },
    )
    return () => { gone = true }
  }, [mode, days])

  const mock = useMemo(() => (mode === 'live' ? undefined : mockAnalytics(days, state.agents, state.projects)), [mode, days, state.agents, state.projects])
  const data = mode === 'live' ? (live?.days === days ? live.data : undefined) : mock
  const error = mode === 'live' && live?.days === days ? live.error : undefined

  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 font-display text-[26px] font-semibold">Spend & usage</h1>
          <p className="mb-0 mt-1.5 text-ink-muted">Where the money and tokens went, and where a cheaper model would likely do.</p>
        </div>
        <div role="group" aria-label="Range" className="flex rounded-md border border-line bg-well p-0.5">
          {([7, 30] as const).map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
              className={cx('rounded-sm px-3 py-1 text-[13px]', days === d ? 'bg-raised font-semibold text-ink' : 'text-ink-muted hover:text-ink')}>
              {d} days
            </button>
          ))}
        </div>
      </div>

      {error && <div className="rounded-lg border border-st-error/40 bg-st-error/10 px-3.5 py-2.5 text-[13px] text-st-error">✕ {error}</div>}
      {!data && !error && <div className="text-ink-dim" aria-live="polite">Loading…</div>}
      {data && <Body a={data} />}
    </>
  )
}

function Body({ a }: { a: Analytics }) {
  const t = a.totals
  const tiles: [string, string, string?][] = [
    ['Spend', usd(t.costUsd), `${usd(t.costUsd / a.days)} / day`],
    ['Tokens', tokens(t.tokens)],
    ['Quests done', String(t.questsDone), t.questsFailed ? `${t.questsFailed} failed` : undefined],
    ['Per quest', t.costPerQuestUsd == null ? '–' : usd(t.costPerQuestUsd)],
  ]
  return (
    <>
      <section className={cx(card, 'grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4')} aria-label="Totals">
        {tiles.map(([label, value, sub]) => (
          <div key={label}>
            <div className="text-label">{label}</div>
            <div className="text-numeral mt-1 text-[26px] leading-none">{value}</div>
            {sub && <div className="mt-1 text-xs text-ink-dim">{sub}</div>}
          </div>
        ))}
      </section>

      <DailyChart a={a} />

      <Breakdown title="By base" rows={a.byProject.map((p) => ({ key: p.projectId, label: p.name, t: p }))} />
      <Breakdown title="By role" rows={a.byRole.map((r) => ({ key: r.role, label: ROLE_LABEL[r.role] ?? r.role, t: r }))} />
      <Breakdown title="By model" rows={a.byModel.map((m) => ({ key: m.model, label: m.name, t: m }))} />

      <section className="flex flex-col gap-3" aria-labelledby="recs-h">
        <h2 id="recs-h" className="m-0 font-display text-lg font-semibold">Recommendations</h2>
        {a.recommendations.length === 0
          ? <p className={cx(card, 'm-0 text-[13px] text-ink-muted')}>{a.note ?? 'Nothing to recommend right now.'}</p>
          : a.recommendations.map((r) => <RecCard key={r.id} r={r} />)}
      </section>
    </>
  )
}

function DailyChart({ a }: { a: Analytics }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...a.daily.map((d) => d.costUsd), 0.01)
  const every = a.daily.length > 10 ? 5 : 1
  const h = hover == null ? undefined : a.daily[hover]
  return (
    <section className={card} aria-labelledby="daily-h">
      <div className="flex flex-wrap items-baseline gap-3">
        <b id="daily-h">Daily spend</b>
        <span className="text-xs text-ink-dim">{dayLabel(a.from)} – {dayLabel(a.to)} · peak {usd(max)}</span>
        <span className="ml-auto min-h-[18px] text-xs text-ink-muted" aria-hidden>
          {h ? <>{dayLabel(h.day, true)} · <b className="text-ink">{usd(h.costUsd)}</b> · {tokens(h.tokens)} tokens · {h.questsDone} quest{h.questsDone === 1 ? '' : 's'}</> : 'Hover a bar for the day'}
        </span>
      </div>
      {/* Visual only; the table below carries the same numbers for screen readers. */}
      <div aria-hidden className="mt-3 flex h-[120px] items-end gap-[2px] border-b border-line" onMouseLeave={() => setHover(null)}>
        {a.daily.map((d, i) => (
          <div key={d.day} className="flex h-full min-w-0 flex-1 items-end" onMouseEnter={() => setHover(i)}>
            <div className={cx('w-full rounded-t-[4px] transition-colors duration-[80ms]', hover === i ? 'bg-ink' : 'bg-ink-dim')}
              style={{ height: d.costUsd > 0 ? `${Math.max(2, (d.costUsd / max) * 100)}%` : 0 }} />
          </div>
        ))}
      </div>
      <div aria-hidden className="mt-1 flex gap-[2px] text-[10px] text-ink-dim">
        {a.daily.map((d, i) => <span key={d.day} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">{i % every === 0 ? dayLabel(d.day) : ''}</span>)}
      </div>
      <details className="mt-3 text-[13px]">
        <summary className="cursor-pointer text-xs text-ink-muted">Show as table</summary>
        <table className="mt-2 w-full border-collapse">
          <caption className="sr-only">Daily spend, tokens and quests done</caption>
          <thead><tr>{['Day', 'Spend', 'Tokens', 'Quests'].map((x, i) => <th key={x} scope="col" className={cx('text-label py-1.5', i ? 'text-right' : 'text-left')}>{x}</th>)}</tr></thead>
          <tbody>
            {a.daily.map((d) => (
              <tr key={d.day} className="border-t border-line-soft">
                <th scope="row" className="py-1.5 text-left font-normal">{dayLabel(d.day, true)}</th>
                <td className="text-right tabular-nums">{usd(d.costUsd)}</td>
                <td className="text-right tabular-nums">{tokens(d.tokens)}</td>
                <td className="text-right tabular-nums">{d.questsDone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  )
}

function Breakdown({ title, rows }: { title: string; rows: { key: string; label: string; t: UsageTotals }[] }) {
  return (
    <section className={card}>
      <table className="w-full border-collapse text-[13px]">
        <caption className="pb-2 text-left font-semibold text-ink">{title}</caption>
        <thead>
          <tr>{['', 'Spend', 'Tokens', 'Quests', 'Per quest'].map((x, i) => <th key={i} scope="col" className={cx('text-label py-1.5', i ? 'text-right' : 'text-left')}>{x || title.replace('By ', '')}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={5} className="border-t border-line-soft py-2 text-ink-dim">No usage in this range.</td></tr>}
          {rows.map(({ key, label, t }) => (
            <tr key={key} className="border-t border-line-soft">
              <th scope="row" className={cx('py-2 text-left font-medium', key === 'unknown' && 'text-ink-dim')}>{label}</th>
              <td className="text-right tabular-nums">{usd(t.costUsd)}</td>
              <td className="text-right tabular-nums">{tokens(t.tokens)}</td>
              <td className="text-right tabular-nums">{t.questsDone}{t.questsFailed ? <span className="text-st-error"> · {t.questsFailed}✕</span> : null}</td>
              <td className="text-right tabular-nums">{t.costPerQuestUsd == null ? '–' : usd(t.costPerQuestUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

const CONF: Record<Recommendation['confidence'], string> = { high: '●●● high', medium: '●●○ medium', low: '●○○ low' }

function RecCard({ r }: { r: Recommendation }) {
  return (
    <article className={cx(card, 'flex flex-col gap-1.5')}>
      <div className="flex flex-wrap items-baseline gap-3">
        <b className="min-w-0 flex-1 font-medium">{r.title}</b>
        {r.savingsUsdPerWeek != null && <span className="text-numeral text-[17px] text-st-done">−{usd(r.savingsUsdPerWeek)}/wk</span>}
      </div>
      <p className="m-0 text-[13px] leading-normal text-ink-muted">{r.detail}</p>
      <span className="text-xs text-ink-dim">Confidence <span className="font-mono">{CONF[r.confidence]}</span></span>
    </article>
  )
}
