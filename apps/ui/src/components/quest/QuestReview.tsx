// The way from a quest to its merge review (feedback #15). Live merge requests link back with
// `MergeRequest.questId`; mock quests carry a `prNumber`. Both resolve through mergeRequestForQuest.
import { Link } from 'react-router-dom'
import type { Quest } from '@/types/colony'
import { useStore, mergeRequestForQuest, reviewHref } from '@/store/store'
import { ago } from '@/lib/util'

function useQuestReview(quest: Quest) {
  const { state, mode } = useStore()
  const mr = mergeRequestForQuest(state, quest)
  const href = reviewHref(mode, mr, quest)
  const orchestrator = state.agents.find((a) => a.projectId === quest.projectId && a.role === 'orchestrator')
  return { mr, href, orchestrator }
}

/** Header action: "Review merge →" while a merge request waits, otherwise the review's state. */
export function QuestReviewAction({ quest }: { quest: Quest }) {
  const { mr, href, orchestrator } = useQuestReview(quest)
  if (quest.status === 'in_review') {
    if (href && (!mr || mr.status === 'pending')) {
      return <Link to={href} className="rounded-md bg-you px-3.5 py-1.5 text-[13px] font-bold text-you-ink no-underline">Review merge →</Link>
    }
    if (mr && href && mr.status === 'changes_requested') {
      return <Link to={href} className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-soft no-underline">↩ Changes requested · view review</Link>
    }
    return <span className="rounded-md border border-line-soft px-3 py-1.5 text-[13px] text-ink-dim">◷ Waiting for {orchestrator?.callsign ?? 'the Orchestrator'}’s review</span>
  }
  if (quest.status === 'done' && href) {
    const when = mr?.approvedAt ? ` ${ago(mr.approvedAt)} ago` : ''
    return (
      <Link to={href} className="rounded-md border border-st-done/45 bg-st-done/10 px-3 py-1.5 text-[13px] text-st-done no-underline">
        ✓ Merged{mr?.approvedBy === 'you' ? ` · approved by you${when}` : ''} →
      </Link>
    )
  }
  return null
}

/** Side panel "Pull request" row. */
export function PullRequestRow({ quest }: { quest: Quest }) {
  const { mr, href } = useQuestReview(quest)
  const pr = mr?.prNumber ?? quest.prNumber
  const label = mr?.status === 'merged' ? 'merged' : mr?.status === 'approved' ? 'approved' : mr?.status === 'changes_requested' ? 'changes requested' : mr ? 'waiting for you' : ''
  return (
    <div className="flex justify-between gap-3">
      <span>Pull request</span>
      {href
        ? <Link to={href} className="truncate">{pr ? `#${pr}` : 'Merge review'}{label && <span className="text-ink-dim"> · {label}</span>} →</Link>
        : <span className="text-ink-dim">not opened yet</span>}
    </div>
  )
}
