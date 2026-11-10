import { useState } from 'react'
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

export function QuestBoard({ project, layout = 'columns' }: { project: Project; layout?: 'columns' | 'lanes' }) {
  const { state, dispatch } = useStore()
  const qs = projectQuests(state, project)
  const [draft, setDraft] = useState<string | null>(null)
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
        <span className="text-xs text-ink-dim">{qs.length} quests · {qs.filter((q) => q.createdBy === 'you').length} by you</span>
        {draft === null
          ? <button type="button" onClick={() => setDraft('')} className="ml-auto rounded-sm border border-line bg-raised px-2.5 py-1.5 text-xs">+ New quest</button>
          : <form className="ml-auto flex gap-1.5" onSubmit={(e) => { e.preventDefault(); addQuest() }}>
              <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => !draft && setDraft(null)} aria-label="New quest title" placeholder="Quest title…"
                className="w-56 rounded-sm border border-line bg-surface px-2 py-1 text-xs" />
              <button type="submit" className="rounded-sm bg-ink px-2.5 text-xs font-semibold text-ground">Add</button>
            </form>}
      </div>
      <div className={layout === 'columns' ? 'grid grid-cols-2 gap-3 lg:grid-cols-4' : 'flex flex-col gap-4'}>
        {order.map((c) => {
          const items = qs.filter((q) => c.statuses.includes(q.status))
          const st = QUEST_STATUS[c.key]
          return (
            <div key={c.name} className={cx('flex min-w-0 flex-col gap-2', layout === 'columns' && 'rounded-lg border border-line-soft bg-well p-2.5')}>
              <div className="flex items-center gap-2 px-0.5 text-xs font-semibold text-ink-soft">
                <span className={st.text}>{st.glyph}</span>{c.name}<span className="ml-auto font-mono font-normal text-ink-dim">{items.length}</span>
              </div>
              {items.map((q) => <QuestCard key={q.id} quest={q} />)}
            </div>
          )
        })}
      </div>
    </section>
  )
}
