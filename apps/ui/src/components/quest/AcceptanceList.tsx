// Acceptance criteria with who verifies them (feedback #11): a QA agent checks the agent-checkable
// ones on the branch; the human ones are "Needs you" and the commander ticks them here.
import { useState } from 'react'
import type { Quest } from '@/types/colony'
import { useStore } from '@/store/store'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { Bar } from '@/components/ui/controls'
import { cx } from '@/lib/util'

export function AcceptanceList({ quest }: { quest: Quest }) {
  const { state, dispatch, mode } = useStore()
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState('')
  const items = quest.acceptance
  const done = items.filter((c) => c.done).length
  const needsYou = items.filter((c) => c.check === 'human' && !c.done).length
  const verifier = quest.verifierId ? state.agents.find((a) => a.id === quest.verifierId)?.callsign : undefined
  const who = (by: string) => (by === 'you' ? 'you' : state.agents.find((a) => a.id === by)?.callsign ?? by)

  const toggle = async (index: number, next: boolean) => {
    setErr('')
    if (mode !== 'live') {
      const acceptance = items.map((c, i) => (i === index ? { ...c, done: next, verification: next ? { by: 'you' as const, result: 'pass' as const, at: new Date().toISOString() } : undefined } : c))
      dispatch({ type: 'upsertQuest', quest: { ...quest, acceptance } })
      return
    }
    setBusy(index)
    try {
      const q = await endpoints.questAcceptance(quest.id, index, next)
      dispatch({ type: 'upsertQuest', quest: q })
    } catch (e) { setErr(errorMessage(e)) } finally { setBusy(null) }
  }

  return (
    <>
      <h2 className="text-section mb-2.5">Acceptance · {done} of {items.length}</h2>
      <div className="mb-2"><Bar pct={items.length ? (done / items.length) * 100 : 0} className="bg-st-run" h="h-1.5" /></div>
      <p className="m-0 mb-3 text-xs text-ink-dim">
        {verifier ? `Agent-checkable criteria are verified by ${verifier}. ` : 'A QA agent verifies agent-checkable criteria before review. '}
        {needsYou ? <b className="font-semibold text-st-you">{needsYou} need{needsYou === 1 ? 's' : ''} you.</b> : null}
      </p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map((c, i) => {
          const human = c.check === 'human'
          const v = c.verification
          const failed = v?.result === 'fail'
          return (
            <li key={`${i}-${c.text}`} className="flex gap-2.5 py-1 text-[13px]">
              {human || mode !== 'live' || c.done || v
                ? (
                  <input type="checkbox" checked={c.done} disabled={busy === i} onChange={(e) => void toggle(i, e.target.checked)}
                    aria-label={`${c.done ? 'Untick' : 'Tick'}: ${c.text}`} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-you)]" />
                )
                : <span className="mt-0.5 w-4 shrink-0 text-center font-mono text-ink-dim">○</span>}
              <span className="min-w-0 flex-1">
                <span className={cx(c.done ? '' : failed ? 'text-st-error' : 'text-ink-muted')}>{c.text}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                  {human
                    ? <span className={cx('rounded-full border px-1.5', c.done ? 'border-st-done/40 text-st-done' : 'border-st-you/50 text-st-you')}>{c.done ? `✓ checked by ${who(v?.by ?? 'you')}` : '! Needs you'}</span>
                    : v
                      ? <span className={cx('rounded-full border px-1.5', failed ? 'border-st-error/50 text-st-error' : 'border-st-done/40 text-st-done')}>{failed ? '✕ failed' : '✓ passed'} · {who(v.by)}</span>
                      : <span className="rounded-full border border-line px-1.5 text-ink-dim">QA agent · not verified yet</span>}
                  {c.claimed && !v && <span className="text-ink-dim">worker says done</span>}
                  {v?.evidence && <span className="truncate font-mono text-ink-dim" title={v.evidence}>{v.evidence}</span>}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
      {err && <p className="m-0 mt-2 text-xs text-st-error">✕ {err}</p>}
      {!items.length && <p className="m-0 text-[13px] text-ink-dim">No acceptance criteria yet.</p>}
    </>
  )
}
