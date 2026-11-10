import { Fragment, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useStore } from '@/store/store'
import { Segmented, inputCls } from '@/components/ui/controls'
import { Button } from '@/components/ui/primitives'
import { cx } from '@/lib/util'

const FILES: [string, number, number][] = [
  ['src/components/StreakBadge.tsx', 58, 0], ['src/components/StreakCalendar.tsx', 121, 0], ['src/app/read/page.tsx', 34, 12],
  ['src/hooks/useStreak.ts', 46, 0], ['src/lib/toast.ts', 18, 30], ['src/styles/streak.css', 40, 0],
  ['tests/streak-ui.spec.ts', 72, 0], ['src/app/read/layout.tsx', 6, 2], ['package.json', 1, 1],
]
type Line = { n?: number; s: ' ' | '+' | '-'; t: string; note?: { who: string; cls: string; text: string } }
const LINES: Line[] = [
  { s: ' ', t: '@@ -0,0 +1,17 @@' },
  { n: 1, s: '+', t: "import { useStreak } from '@/hooks/useStreak'" },
  { n: 2, s: '+', t: "import { startOfDay, subDays } from 'date-fns'" },
  { n: 3, s: '+', t: '' },
  { n: 4, s: '+', t: 'export function StreakCalendar({ tz }: { tz: string }) {' },
  { n: 5, s: '+', t: '  const { days, current } = useStreak(tz)' },
  { n: 6, s: '+', t: '  const today = startOfDay(new Date())', note: { who: 'Kip-03 · QA', cls: 'text-st-done', text: "Verified: `today` is only used for layout; streak math happens server-side in the reader's time zone." } },
  { n: 7, s: '+', t: '  const range = Array.from({ length: 30 }, (_, i) => subDays(today, 29 - i))' },
  { n: 8, s: '+', t: '' },
  { n: 9, s: '+', t: '  return (' },
  { n: 10, s: '+', t: '    <ol role="grid" aria-label={`${current} day streak`}>' },
  { n: 11, s: '+', t: '      {range.map((d) => (' },
  { n: 12, s: '+', t: '        <li key={d.toISOString()} data-read={days.has(+d)} tabIndex={-1} />' },
  { n: 13, s: '+', t: '      ))}', note: { who: 'Atlas-01 · Orchestrator', cls: 'text-st-think', text: 'Roving tabindex lives in useGridNav (added in #44), so arrow keys work without extra code here.' } },
  { n: 14, s: '+', t: '    </ol>' },
  { n: 15, s: '+', t: '  )' },
  { n: 16, s: '+', t: '}' },
]

export function Review() {
  const { pr } = useParams()
  const { state, dispatch } = useStore()
  const quest = state.quests.find((q) => String(q.prNumber) === pr)
  const [file, setFile] = useState(1)
  const [view, setView] = useState<'unified' | 'split'>('unified')
  const [feedback, setFeedback] = useState('')
  const [outcome, setOutcome] = useState<'open' | 'merged' | 'changes'>(quest?.status === 'done' ? 'merged' : 'open')
  if (!quest) return <p className="p-8 text-ink-muted">No open pull request #{pr}. <Link to="/inbox">Back to inbox</Link></p>
  const st = { open: ['! Needs your approval', 'text-st-you bg-st-you/12 border-st-you/45'], merged: ['✓ Merged', 'text-st-done bg-st-done/12 border-st-done/45'], changes: ['↩ Changes requested', 'text-st-run bg-st-run/12 border-st-run/45'] }[outcome]
  const approve = () => { dispatch({ type: 'merge', questId: quest.id }); setOutcome('merged') }
  const reqChanges = () => { dispatch({ type: 'questStatus', id: quest.id, status: 'in_progress' }); setOutcome('changes') }
  const undo = () => { dispatch({ type: 'questStatus', id: quest.id, status: 'in_review' }); setOutcome('open') }
  const checks = [['✓', 'text-st-done', 'Unit + integration tests', '145 / 145'], ['✓', 'text-st-done', 'Playwright · streak-ui.spec', '8 / 8'], ['✓', 'text-st-done', 'Type check', 'clean'],
    ['✓', 'text-st-done', 'Lint', 'clean'], ['✓', 'text-st-done', 'Bundle size (goal < 200 kB)', '184 kB · +6'], ['!', 'text-st-blocked', 'Flake watch', '1 in 5 runs, other file']]

  return (
    <div className="flex min-h-[calc(100vh-57px)] flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b border-line-soft bg-hud px-6 py-3.5">
        <Link to="/inbox" className="text-[13px] text-ink-muted no-underline">← Inbox</Link>
        <div><div className="text-label">Readable · merge review</div><h1 className="m-0 mt-0.5 font-display text-2xl font-semibold">{quest.title} <span className="font-mono text-sm font-normal text-ink-muted">PR #{quest.prNumber}</span></h1></div>
        <span className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs text-ink-soft">{quest.branch} → main</span>
        <span className="text-xs text-ink-muted"><span className="text-st-done">+412</span> <span className="text-st-error">−88</span> · {FILES.length} files</span>
        <span className={cx('ml-auto rounded-full border px-3 py-1 text-xs font-semibold', st[1])}>{st[0]}</span>
      </header>
      <div className="flex flex-1 flex-wrap">
        <aside className="flex max-w-[360px] flex-[1_1_320px] flex-col gap-4 border-r border-line-soft bg-well p-4.5">
          <section className="rounded-lg border border-st-think/35 bg-surface px-3.5 py-3">
            <div className="mb-1.5 text-[11px] uppercase tracking-[.12em] text-st-think">Summary · Atlas-01</div>
            <p className="m-0 text-[13px] leading-relaxed">Adds a streak counter to the reading screen, a calendar of the last 30 days and a "streak saved" toast. Reads from <span className="font-mono text-xs">/api/streaks</span>. No schema changes.</p>
          </section>
          <section>
            <div className="text-label mb-2">Checks</div>
            {checks.map(([g, c, t, v]) => <div key={t} className="flex items-center gap-2.5 border-b border-line-soft py-1.5 text-[13px]"><span className={cx('w-4 font-mono', c)}>{g}</span><span className="flex-1">{t}</span><span className={cx('text-xs', c)}>{v}</span></div>)}
          </section>
          <section className="rounded-lg border border-line bg-surface px-3.5 py-3">
            <div className="text-label mb-1.5">QA notes · Kip-03</div>
            <ul className="m-0 list-disc pl-4.5 text-[13px] leading-relaxed text-ink-soft"><li>Checked rollover in UTC, America/Vancouver and Asia/Tokyo.</li><li>Calendar is keyboard navigable; screen reader reads "7 day streak".</li><li>One flake in reminder.test.ts on run 3 of 5; not in this PR.</li></ul>
          </section>
          <section>
            <div className="text-label mb-2">Files</div>
            {FILES.map(([n, a, d], i) => (
              <button key={n} type="button" onClick={() => setFile(i)} className={cx('flex w-full justify-between gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-xs', i === file ? 'bg-raised' : 'hover:bg-surface')}>
                <span className="truncate">{i < file ? '✓' : i === file ? '▸' : '·'} {n}</span><span className="shrink-0"><span className="text-st-done">+{a}</span> <span className="text-st-error">−{d}</span></span>
              </button>
            ))}
          </section>
        </aside>
        <main className="flex min-w-0 flex-[999_1_640px] flex-col">
          <div className="flex items-center gap-2.5 border-b border-line-soft px-5.5 py-3">
            <span className="font-mono text-[13px]">{FILES[file][0]}</span>
            <span className="ml-auto" />
            <Segmented label="Diff view" value={view} onChange={setView} options={[{ id: 'unified', label: 'Unified' }, { id: 'split', label: 'Split' }]} />
          </div>
          <div className="flex-1 overflow-auto px-5.5 py-4">
            {view === 'unified' ? (
              <div className="overflow-hidden rounded-lg border border-line-soft bg-well font-mono text-[12.5px] leading-[1.75]">
                {LINES.map((l, i) => (
                  <div key={i}>
                    <div className={cx('flex', l.s === '+' && 'bg-st-done/8', l.s === '-' && 'bg-st-error/8')}>
                      <span className="w-11 shrink-0 select-none pr-2.5 text-right text-[#56606E]">{l.n ?? ''}</span>
                      <span className={cx('w-4 shrink-0', l.s === '+' ? 'text-diff-add' : 'text-ink-muted')}>{l.s}</span>
                      <span className={cx('whitespace-pre', l.s === '+' ? 'text-diff-add' : 'text-ink-muted')}>{l.t}</span>
                    </div>
                    {l.note && <div className="mb-2 ml-[60px] mr-3 mt-1.5 whitespace-normal rounded-md border border-line bg-surface px-3 py-2.5 font-sans text-[13px] leading-normal"><b className={l.note.cls}>{l.note.who}</b> · {l.note.text}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line-soft bg-line-soft font-mono text-[12.5px] leading-[1.75]">
                {LINES.filter((l) => l.n).map((l, i) => (<Fragment key={i}><div className="bg-well px-2.5">&nbsp;</div><div className="whitespace-pre bg-st-done/8 px-2.5 text-diff-add">{l.t || ' '}</div></Fragment>))}
              </div>
            )}
          </div>
          <div className="sticky bottom-0 border-t border-line-soft bg-well px-5.5 py-3.5">
            {outcome === 'open' && (
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-[1_1_380px] flex-col gap-1.5 text-xs text-ink-muted">Feedback for the author (sent if you request changes)
                  <textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. Use the existing Toast component instead of a new one" className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-ink-muted">Merge as<select className={inputCls}><option>Squash · 1 commit</option><option>Merge commit</option><option>Rebase</option></select></label>
                <Button onClick={reqChanges}>Request changes</Button>
                <Button variant="command" kbd="A" onClick={approve}>✓ Approve &amp; merge</Button>
              </div>
            )}
            {outcome === 'merged' && (
              <div className="flex animate-pop items-center gap-3.5">
                <span className="grid h-[34px] w-[34px] place-items-center rounded-full bg-st-done/16 text-lg text-st-done">✓</span>
                <div className="flex-1"><b>Merged into main</b> · squashed · branch deleted<div className="text-xs text-ink-muted">Quest → Done · +{quest.xpReward} XP · dependents unblocked</div></div>
                <Button variant="ghost" onClick={undo}>Undo · revert PR (10 s)</Button>
                <Link to="/base/1" className="text-[13px]">Back to base →</Link>
              </div>
            )}
            {outcome === 'changes' && (
              <div className="flex animate-pop items-center gap-3.5">
                <span className="grid h-[34px] w-[34px] place-items-center rounded-full bg-st-run/16 text-st-run">↩</span>
                <div className="flex-1"><b>Sent back</b>{feedback && <> · “{feedback}”</>}<div className="text-xs text-ink-muted">Quest moves to In progress. QA re-reviews on the next push.</div></div>
                <Button variant="ghost" onClick={undo}>Undo</Button>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
