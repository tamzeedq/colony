// Checkpoints and revert for an agent's branch (docs/phase6.md §2). Live mode only.
import { useCallback, useEffect, useState } from 'react'
import type { Agent } from '@/types/colony'
import { endpoints, type AgentCommits, type CommitView } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/primitives'
import { cx } from '@/lib/util'

const BUSY = new Set(['running', 'editing', 'thinking'])
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

export function Checkpoints({ agent }: { agent: Agent }) {
  const [data, setData] = useState<AgentCommits | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<CommitView | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!agent.branch) return
    endpoints.agentCommits(agent.id).then((d) => { setData(d); setErr(null) }, (e) => setErr(errorMessage(e)))
  }, [agent.id, agent.branch])
  useEffect(load, [load])

  if (!agent.branch) return null
  const head = data?.commits[0]
  const working = BUSY.has(agent.status)
  const lost = confirm && data ? data.commits.findIndex((c) => c.sha === confirm.sha) : 0

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setNote(null)
    try { await fn(); setNote(done); setConfirm(null); load() } catch (e) { setNote(`✕ ${errorMessage(e)}`) } finally { setBusy(false) }
  }

  return (
    <section aria-label="Checkpoints" className="mt-4 border-t border-line-soft pt-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-label">History · ⎇ {agent.branch}</span>
        <span className="ml-auto flex gap-1.5">
          <Button variant="ghost" className="min-h-7 px-2.5 text-xs" disabled={busy || !head}
            onClick={() => run(() => endpoints.checkpoint(agent.id, 'Checkpoint by you'), '✓ Checkpoint saved')}>⚑ Checkpoint</Button>
          {data?.lastBackup && head && data.lastBackup.sha !== head.sha && (
            <Button variant="ghost" className="min-h-7 px-2.5 text-xs" disabled={busy}
              onClick={() => run(() => endpoints.revert(agent.id, { to: data.lastBackup!.sha, force: working }), '✓ Last revert undone')}>↶ Undo last revert</Button>
          )}
        </span>
      </div>
      {err && <p className="text-sm text-st-error">✕ Couldn’t load the history · {err}</p>}
      {note && <p className={cx('mb-2 text-xs', note.startsWith('✕') ? 'text-st-error' : 'text-st-done')}>{note}</p>}
      {data && !data.commits.length && <p className="text-sm text-ink-dim">No commits on ⎇ {agent.branch} yet.</p>}
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {data?.commits.map((c, i) => (
          <li key={c.sha} className={cx('flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs', c.inMain ? 'text-ink-dim' : 'hover:bg-surface')}>
            <span className="font-mono text-ink-muted">{c.sha.slice(0, 7)}</span>
            <span className="min-w-0 flex-1 truncate">{c.subject}</span>
            {c.checkpoint && <span className="shrink-0 rounded-xs border border-st-done/40 px-1.5 text-[10px] text-st-done" title={c.checkpoint}>⚑ {c.checkpoint.length > 28 ? `${c.checkpoint.slice(0, 27)}…` : c.checkpoint}</span>}
            {c.inMain && <span className="shrink-0 text-[10px]">in main</span>}
            <span className="w-9 shrink-0 text-right font-mono text-[10px] text-ink-dim">{ago(c.at)}</span>
            {i > 0 && !(c.inMain && data.commits[i - 1]?.inMain)
              ? <button type="button" disabled={busy} onClick={() => setConfirm(c)} className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-ink-soft hover:border-line-strong disabled:opacity-50">Revert to here</button>
              : <span className="w-[86px] shrink-0" />}
          </li>
        ))}
      </ol>
      {confirm && (
        <div role="alertdialog" aria-label="Confirm revert" className="mt-2 rounded-md border border-st-error/50 bg-st-error/10 p-3 text-xs">
          <p className="m-0 mb-2">
            Move ⎇ {agent.branch} back to <b className="font-mono">{confirm.sha.slice(0, 7)}</b>. This drops the {lost} newer commit{lost === 1 ? '' : 's'} from the branch
            and any uncommitted changes in {agent.callsign}’s workspace. A backup is kept, so you can undo it.
            {working && <> {agent.callsign} is {agent.status}; reverting now interrupts its work.</>}
          </p>
          <div className="flex gap-2">
            <Button variant="danger" className="min-h-7 px-2.5 text-xs" disabled={busy}
              onClick={() => run(() => endpoints.revert(agent.id, { to: confirm.sha, force: working }), `✓ Reverted to ${confirm.sha.slice(0, 7)}`)}>Revert</Button>
            <Button variant="ghost" className="min-h-7 px-2.5 text-xs" onClick={() => setConfirm(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  )
}
