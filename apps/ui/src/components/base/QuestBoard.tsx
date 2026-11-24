import { useState } from 'react'
import { endpoints } from '@/api/endpoints'
import { Link } from 'react-router-dom'
import type { Project, Quest, QuestStatus } from '@/types/colony'
import { QUEST_STATUS, ROLES } from '@/design/status'
import { useStore, projectQuests } from '@/store/store'
import { cx } from '@/lib/util'

const COLS: { name: string; statuses: QuestStatus[]; key: QuestStatus }[] = [
  { name: 'Backlog', statuses: ['backlog'], key: 'backlog' },
  { name: 'In progress', statuses: ['in_progress', 'blocked'], key: 'in_progress' },
  { name: 'In review', statuses: ['in_review'], key: 'in_review' },
  { name: 'Done', statuses: ['done', 'failed'], key: 'done' },
]

export function QuestCard({ quest }: { quest: Quest }) {
  const { state } = useStore()
  const a = state.agents.find((x) => x.id === quest.assigneeId)
  const qs = QUEST_STATUS[quest.status]
  const blocker = quest.status === 'blocked' && state.quests.find((q) => quest.dependsOn.includes(q.id) && q.status !== 'done')
  const note = quest.status === 'in_review' ? '! Waiting on your merge approval'
    : quest.status === 'blocked' ? `⊘ blocked by ${blocker ? blocker.title : 'a dependency'}`
    : quest.status === 'done' ? `✓ +${quest.xpReward} XP`
    : quest.status === 'failed' ? '✕ agent crashed · reassign?'
    : quest.dependsOn.length && quest.status === 'backlog' ? `⧉ ${quest.dependsOn.length} dependency` : ''
  const to = quest.prNumber && quest.status === 'in_review' ? `/review/${quest.prNumber}` : `/quest/${quest.id}`
  return (
    <Link to={to} className={cx('block rounded-md border bg-surface p-2.5 text-ink no-underline hover:border-line-strong', quest.status === 'in_review' ? 'border-st-you/45' : 'border-line')}>
      <div className="text-[13px] font-medium leading-snug">{quest.title}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="rounded-xs bg-raised px-1.5 text-[11px] text-ink-soft">{a ? `${ROLES[a.role].code} · ${a.callsign}` : 'Unassigned'}</span>
        <span className="max-w-full truncate font-mono text-[10px] text-ink-dim">{quest.prNumber ? `PR #${quest.prNumber}` : quest.branch ?? ''}</span>
      </div>
      {note && <div className={cx('mt-1.5 text-[11px]', qs.text)}>{note}</div>}
    </Link>
  )
}

/** Done lane: the most recent finished quests; older ones are behind "show all" (archived ones are off the board). */
const DONE_SHOWN = 8
const finishedAt = (q: Quest) => q.finishedAt ?? q.createdAt

export function QuestBoard({ project, layout = 'columns' }: { project: Project; layout?: 'columns' | 'lanes' }) {
  const { state, dispatch, mode } = useStore()
  const all = projectQuests(state, project)
  const qs = all.filter((q) => !q.archivedAt)
  const archived = all.filter((q) => q.archivedAt).sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
  const finished = qs.filter((q) => q.status === 'done' || q.status === 'failed')
  const [draft, setDraft] = useState<string | null>(null)
  const [allDone, setAllDone] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [busy, setBusy] = useState(false)
  const live = mode === 'live'
  const archiveFinished = async () => {
    setBusy(true)
    try { await endpoints.archiveFinished(project.id) } finally { setBusy(false); setConfirmArchive(false) }
  }
  const addQuest = () => {
    const title = draft?.trim()
    setDraft(null)
    if (title) dispatch({ type: 'addQuest', quest: { id: `q-${Date.now()}`, projectId: project.id, title, brief: '', status: 'backlog', priority: 'normal', createdBy: 'you', dependsOn: [], acceptance: [], xpReward: 100, createdAt: new Date().toISOString() } })
  }
  const order = layout === 'lanes' ? [COLS[2], COLS[1], COLS[0], COLS[3]] : COLS
  return (
    <section aria-label="Quest board">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-section">Quest board</h2>
        <span className="text-xs text-ink-dim">{qs.length} quests · {qs.filter((q) => q.createdBy === 'you').length} by you{archived.length ? ` · ${archived.length} archived` : ''}</span>
        {live && finished.length > 0 && (confirmArchive
          ? <span className="ml-auto flex items-center gap-1.5 text-xs">
              <span className="text-ink-muted">Archive {finished.length} finished quest{finished.length > 1 ? 's' : ''}? You can restore them.</span>
              <button type="button" disabled={busy} onClick={archiveFinished} className="rounded-sm bg-ink px-2.5 py-1 font-semibold text-ground">Archive</button>
              <button type="button" onClick={() => setConfirmArchive(false)} className="rounded-sm border border-line px-2.5 py-1">Cancel</button>
            </span>
          : <button type="button" onClick={() => setConfirmArchive(true)} className="ml-auto rounded-sm border border-line px-2.5 py-1.5 text-xs text-ink-soft" title="Move done and cancelled quests off the board (restorable)">▣ Archive finished</button>)}
        {draft === null
          ? <button type="button" onClick={() => setDraft('')} className={cx('rounded-sm border border-line bg-raised px-2.5 py-1.5 text-xs', !(live && finished.length > 0) && 'ml-auto')}>+ New quest</button>
          : <form className="ml-auto flex gap-1.5" onSubmit={(e) => { e.preventDefault(); addQuest() }}>
              <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => !draft && setDraft(null)} aria-label="New quest title" placeholder="Quest title…"
                className="w-56 rounded-sm border border-line bg-surface px-2 py-1 text-xs" />
              <button type="submit" className="rounded-sm bg-ink px-2.5 text-xs font-semibold text-ground">Add</button>
            </form>}
      </div>
      <div className={layout === 'columns' ? 'grid grid-cols-2 gap-3 lg:grid-cols-4' : 'flex flex-col gap-4'}>
        {order.map((c) => {
          let items = qs.filter((q) => c.statuses.includes(q.status))
          const isDone = c.key === 'done'
          if (isDone) items = [...items].sort((a, b) => finishedAt(b).localeCompare(finishedAt(a)))
          const hidden = isDone && !allDone ? Math.max(0, items.length - DONE_SHOWN) : 0
          if (hidden) items = items.slice(0, DONE_SHOWN)
          const st = QUEST_STATUS[c.key]
          return (
            <div key={c.name} className={cx('flex min-w-0 flex-col gap-2', layout === 'columns' && 'rounded-lg border border-line-soft bg-well p-2.5')}>
              <div className="flex items-center gap-2 px-0.5 text-xs font-semibold text-ink-soft">
                <span className={st.text}>{st.glyph}</span>{c.name}<span className="ml-auto font-mono font-normal text-ink-dim">{items.length}</span>
              </div>
              {items.map((q) => <QuestCard key={q.id} quest={q} />)}
              {hidden > 0 && <button type="button" onClick={() => setAllDone(true)} className="rounded-md border border-dashed border-line py-1.5 text-[11px] text-ink-muted">+ {hidden} older</button>}
              {isDone && allDone && items.length > DONE_SHOWN && <button type="button" onClick={() => setAllDone(false)} className="rounded-md border border-dashed border-line py-1.5 text-[11px] text-ink-muted">Show recent only</button>}
            </div>
          )
        })}
      </div>
      {archived.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowArchived((v) => !v)} className="text-xs text-ink-muted hover:text-ink">{showArchived ? '▾' : '▸'} Archived ({archived.length})</button>
          {showArchived && (
            <div className="mt-2 flex flex-col gap-1">
              {archived.map((q) => (
                <div key={q.id} className="flex items-center gap-3 rounded-md border border-line-soft px-3 py-1.5 text-[13px]">
                  <span className={cx('font-mono', QUEST_STATUS[q.status].text)}>{QUEST_STATUS[q.status].glyph}</span>
                  <Link to={`/quest/${q.id}`} className="min-w-0 flex-1 truncate text-ink-muted no-underline hover:text-ink">{q.title}</Link>
                  <span className="text-[11px] text-ink-dim">archived {q.archivedAt?.slice(0, 10)}</span>
                  {live && <button type="button" onClick={() => void endpoints.setQuestArchived(q.id, false)} className="rounded-sm border border-line px-2 py-0.5 text-xs">Restore</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
