// Merge review on live data: /review/:id resolves a MergeRequest (by id, falling back to
// prNumber), shows the real diff of its branch vs main, and approves / requests changes.
// HARD RULE: only this human approval lets anything merge to main (canMergeToMain on the server).
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useStore } from '@/store/store'
import { ROLES } from '@/design/status'
import { Segmented, inputCls } from '@/components/ui/controls'
import { Button } from '@/components/ui/primitives'
import { useDiff, DiffFileButton, ReviewDiff } from '@/components/review/DiffView'
import { diffTotals } from '@/lib/diff'
import { ago, cx } from '@/lib/util'
import type { MergeRequestStatus } from '@/types/colony'

const STATUS: Record<MergeRequestStatus, [string, string]> = {
  pending: ['! Needs your approval', 'text-st-you bg-st-you/12 border-st-you/45'],
  approved: ['✓ Approved · merging', 'text-st-run bg-st-run/12 border-st-run/45'],
  merged: ['✓ Merged', 'text-st-done bg-st-done/12 border-st-done/45'],
  changes_requested: ['↩ Changes requested', 'text-st-run bg-st-run/12 border-st-run/45'],
}

export function ReviewLive() {
  const { id } = useParams()
  const { state, dispatch } = useStore()
  const mr = state.mergeRequests.find((m) => m.id === id) ?? state.mergeRequests.find((m) => m.prNumber != null && String(m.prNumber) === id)
  const project = state.projects.find((p) => p.id === mr?.projectId)
  const diff = useDiff(mr?.projectId, mr?.branch)
  const [file, setFile] = useState(0)
  const [view, setView] = useState<'unified' | 'split'>('unified')
  const [feedback, setFeedback] = useState('')
  const [sentNote, setSentNote] = useState('')
  const [busy, setBusy] = useState<'' | 'approve' | 'changes'>('')
  const [failed, setFailed] = useState(false)
  if (!mr) return <p className="p-8 text-ink-muted">No merge request {id}. <Link to="/inbox">Back to inbox</Link></p>

  const requester = mr.requestedBy === 'you' ? undefined : state.agents.find((a) => a.id === mr.requestedBy)
  const quest = state.quests.find((q) => q.projectId === mr.projectId && q.branch === mr.branch)
  const files = diff.status === 'ok' ? diff.files : []
  const t = diffTotals(files)
  const cur = files[Math.min(file, Math.max(0, files.length - 1))]
  const st = STATUS[mr.status] ?? STATUS.pending

  const approve = async () => {
    setBusy('approve'); setFailed(false)
    const ok = await dispatch({ type: 'approveMerge', id: mr.id })
    setBusy(''); setFailed(!ok)
  }
  const reqChanges = async () => {
    setBusy('changes'); setFailed(false)
    const note = feedback.trim() || 'Changes requested in merge review.'
    const ok = await dispatch({ type: 'requestChanges', id: mr.id, note })
    setBusy('')
    if (ok) setSentNote(feedback.trim())
    else setFailed(true)
  }

  return (
    <div className="flex min-h-[calc(100vh-57px)] flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b border-line-soft bg-hud px-6 py-3.5">
        <Link to="/inbox" className="text-[13px] text-ink-muted no-underline">← Inbox</Link>
        <div>
          <div className="text-label">{project?.name ?? 'Base'} · merge review</div>
          <h1 className="m-0 mt-0.5 font-display text-2xl font-semibold">{quest?.title ?? mr.branch} {mr.prNumber != null && <span className="font-mono text-sm font-normal text-ink-muted">PR #{mr.prNumber}</span>}</h1>
        </div>
        <span className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs text-ink-soft">{mr.branch} → main</span>
        {diff.status === 'ok' && <span className="text-xs text-ink-muted"><span className="text-st-done">+{t.added}</span> <span className="text-st-error">−{t.removed}</span> · {files.length} files</span>}
        <span className={cx('ml-auto rounded-full border px-3 py-1 text-xs font-semibold', st[1])}>{st[0]}</span>
      </header>
      <div className="flex flex-1 flex-wrap">
        <aside className="flex max-w-[360px] flex-[1_1_320px] flex-col gap-4 border-r border-line-soft bg-well p-4.5">
          <section className="rounded-lg border border-st-think/35 bg-surface px-3.5 py-3">
            <div className="mb-1.5 text-[11px] uppercase tracking-[.12em] text-st-think">Requested by · {requester?.callsign ?? 'you'}</div>
            <p className="m-0 text-[13px] leading-relaxed">
              {requester ? `${ROLES[requester.role].name} on ${project?.name ?? 'this base'} asks to merge ` : 'Merge '}
              <span className="font-mono text-xs">{mr.branch}</span> into <span className="font-mono text-xs">main</span>.
              {quest ? <> Quest: {quest.title}.</> : null}
            </p>
          </section>
          <section className="rounded-lg border border-line bg-surface px-3.5 py-3 text-[13px] leading-relaxed text-ink-soft">
            <div className="text-label mb-1.5">Approval</div>
            {mr.approvedBy === 'you' && mr.approvedAt
              ? <>Approved by you {ago(mr.approvedAt)} ago.</>
              : <>Nothing reaches <span className="font-mono text-xs">main</span> without your recorded approval. Agents can only ask.</>}
          </section>
          <section>
            <div className="text-label mb-2">Files</div>
            {diff.status === 'loading' && <p className="m-0 text-xs text-ink-dim">Loading diff…</p>}
            {diff.status === 'error' && <p className="m-0 text-xs text-st-error">✕ {diff.error} <button type="button" onClick={diff.reload} className="ml-1 text-ink underline">Retry</button></p>}
            {diff.status === 'ok' && !files.length && <p className="m-0 text-xs text-ink-dim">No differences from main.</p>}
            {files.map((f, i) => <DiffFileButton key={f.path} file={f} selected={f === cur} prefix={`${i < file ? '✓' : f === cur ? '▸' : '·'} `} onClick={() => setFile(i)} />)}
          </section>
        </aside>
        <main className="flex min-w-0 flex-[999_1_640px] flex-col">
          <div className="flex items-center gap-2.5 border-b border-line-soft px-5.5 py-3">
            <span className="font-mono text-[13px]">{cur?.path ?? mr.branch}</span>
            <span className="ml-auto" />
            <Segmented label="Diff view" value={view} onChange={setView} options={[{ id: 'unified', label: 'Unified' }, { id: 'split', label: 'Split' }]} />
          </div>
          <div className="flex-1 overflow-auto px-5.5 py-4">
            {cur ? <ReviewDiff file={cur} view={view} /> : <p className="text-sm text-ink-dim">{diff.status === 'ok' ? 'Nothing to show.' : diff.status === 'error' ? 'The diff could not be loaded.' : 'Loading…'}</p>}
          </div>
          <div className="sticky bottom-0 border-t border-line-soft bg-well px-5.5 py-3.5">
            {(mr.status === 'pending' || (mr.status === 'approved' && failed)) && (
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-[1_1_380px] flex-col gap-1.5 text-xs text-ink-muted">Feedback for the author (sent if you request changes)
                  <textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. Use the existing Toast component instead of a new one" className={inputCls} />
                </label>
                {failed && <span className="text-xs text-st-error">✕ Didn’t go through. Fix the cause and try again.</span>}
                <Button onClick={() => void reqChanges()} disabled={!!busy}>{busy === 'changes' ? 'Sending…' : 'Request changes'}</Button>
                <Button variant="command" kbd="A" onClick={() => void approve()} disabled={!!busy}>{busy === 'approve' ? 'Merging…' : '✓ Approve & merge'}</Button>
              </div>
            )}
            {mr.status === 'approved' && !failed && (
              <div className="flex items-center gap-3.5">
                <span className="grid h-[34px] w-[34px] animate-breathe place-items-center rounded-full bg-st-run/16 text-st-run">◌</span>
                <div className="flex-1"><b>Approved</b> · merging into main…<div className="text-xs text-ink-muted">The status updates here when the merge lands.</div></div>
              </div>
            )}
            {mr.status === 'merged' && (
              <div className="flex animate-pop items-center gap-3.5">
                <span className="grid h-[34px] w-[34px] place-items-center rounded-full bg-st-done/16 text-lg text-st-done">✓</span>
                <div className="flex-1"><b>Merged into main</b>{mr.approvedAt ? <> · approved by you {ago(mr.approvedAt)} ago</> : null}<div className="text-xs text-ink-muted">{quest ? 'Quest → Done · dependents unblocked' : `${mr.branch} is in main`}</div></div>
                {project && <Link to={`/base/${project.key}`} className="text-[13px]">Back to base →</Link>}
              </div>
            )}
            {mr.status === 'changes_requested' && (
              <div className="flex animate-pop items-center gap-3.5">
                <span className="grid h-[34px] w-[34px] place-items-center rounded-full bg-st-run/16 text-st-run">↩</span>
                <div className="flex-1"><b>Sent back</b>{sentNote && <> · “{sentNote}”</>}<div className="text-xs text-ink-muted">{requester ? `${requester.callsign} got your note and will ask again after the next push.` : 'The author got your note.'}</div></div>
                <Button variant="ghost" onClick={() => void approve()} disabled={!!busy}>Approve anyway</Button>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
