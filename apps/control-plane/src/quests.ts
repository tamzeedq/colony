// Quests and teamwork (docs/phase3.md): the quest lifecycle, dependencies, and the
// `[Colony]` notifications that keep the orchestrator informed. Used by both the MCP tools
// (agents) and the REST routes (the commander).

import type { Agent, MergeRequest, Quest, QuestStatus } from '@colony/shared'
import type { AgentManager } from './agents'
import { badRequest, conflict, infraError, notFound } from './errors'
import type { InfraDriver } from './infra/types'
import { newId, nowIso, type AgentRecord, type Store } from './store'

export const QUEST_STATUSES = ['backlog', 'in_progress', 'in_review', 'done', 'failed', 'blocked'] as const satisfies readonly QuestStatus[]
const PRIORITIES = ['low', 'normal', 'high'] as const
type Priority = (typeof PRIORITIES)[number]

export interface QuestInput {
  title: string
  brief?: string
  why?: string
  acceptance?: string[]
  priority?: Priority
  dependsOn?: string[]
}

export interface QuestPatch {
  title?: string
  brief?: string
  why?: string
  acceptance?: string[]
  priority?: Priority
  dependsOn?: string[]
  status?: QuestStatus
}

const XP_BY_PRIORITY: Record<Priority, number> = { low: 60, normal: 100, high: 150 }

export class QuestService {
  /** Called after a worker completes a quest (Phase 6: automatic checkpoint). */
  onCompleted?: (quest: Quest, rec: AgentRecord, branchSha: string) => void
  constructor(private store: Store, private infra: InfraDriver, private agents: AgentManager) {}

  get(id: string): Quest {
    const q = this.store.quests.get(id)
    if (!q) throw notFound('quest')
    return q
  }

  /** A quest that must belong to `projectId` (agents can only touch their own project). */
  inProject(id: string, projectId: string): Quest {
    const q = this.store.quests.get(id)
    if (!q || q.projectId !== projectId) throw notFound(`quest '${id}' in this project`)
    return q
  }

  orchestratorOf(projectId: string): AgentRecord | undefined {
    return this.store.projectAgents(projectId).find((a) => a.agent.role === 'orchestrator')
  }

  /** Tell the project's orchestrator something (queued if its runner is offline). */
  notifyOrchestrator(projectId: string, text: string, exceptAgentId?: string) {
    const o = this.orchestratorOf(projectId)
    if (!o || o.agent.id === exceptAgentId) return false
    this.agents.deliver(o.agent.id, `[Colony] ${text}`)
    return true
  }

  // ── create / edit ──────────────────────────────────────────────────────────

  create(projectId: string, input: QuestInput, createdBy: string | 'you'): Quest {
    if (!this.store.projects.has(projectId)) throw notFound('project')
    const deps = this.checkDeps(projectId, input.dependsOn ?? [])
    const priority = input.priority ?? 'normal'
    const q: Quest = {
      id: newId('q'), projectId, title: input.title, brief: input.brief ?? '',
      ...(input.why ? { why: input.why } : {}),
      status: 'backlog', priority, createdBy, dependsOn: deps,
      acceptance: (input.acceptance ?? []).map((text) => ({ text, done: false })),
      xpReward: XP_BY_PRIORITY[priority], createdAt: nowIso(),
    }
    this.store.saveQuest(q)
    if (createdBy === 'you') {
      this.notifyOrchestrator(projectId, `The commander added quest ${q.id} "${q.title}"${q.brief ? `: ${q.brief}` : ''}. Plan and staff it like your own quests.`)
    }
    this.store.broadcastSnapshot()
    return q
  }

  private checkDeps(projectId: string, deps: string[], selfId?: string): string[] {
    const out = [...new Set(deps)]
    for (const d of out) {
      if (d === selfId) throw badRequest('a quest cannot depend on itself')
      this.inProject(d, projectId)
    }
    if (selfId) {
      // Reject cycles: walk the new deps and make sure none leads back to this quest.
      const seen = new Set<string>()
      const stack = [...out]
      while (stack.length) {
        const id = stack.pop()!
        if (id === selfId) throw badRequest('that dependency would create a cycle')
        if (seen.has(id)) continue
        seen.add(id)
        stack.push(...(this.store.quests.get(id)?.dependsOn ?? []))
      }
    }
    return out
  }

  /** Edit a quest. `by` decides who gets told about status changes. */
  patch(id: string, input: QuestPatch, by: 'you' | AgentRecord, projectId?: string): Quest {
    const q = projectId ? this.inProject(id, projectId) : this.get(id)
    const next: Quest = { ...q }
    if (input.title !== undefined) next.title = input.title
    if (input.brief !== undefined) next.brief = input.brief
    if (input.why !== undefined) next.why = input.why
    if (input.priority !== undefined) { next.priority = input.priority; next.xpReward = XP_BY_PRIORITY[input.priority] }
    if (input.acceptance !== undefined) {
      const old = new Map(q.acceptance.map((a) => [a.text, a.done]))
      next.acceptance = input.acceptance.map((text) => ({ text, done: old.get(text) ?? false }))
    }
    if (input.dependsOn !== undefined) next.dependsOn = this.checkDeps(q.projectId, input.dependsOn, q.id)
    const statusChanged = input.status !== undefined && input.status !== q.status
    if (statusChanged) next.status = input.status!
    this.store.saveQuest(next)

    if (statusChanged) {
      const who = by === 'you' ? 'The commander' : by.agent.callsign
      const assignee = next.assigneeId ? this.store.agents.get(next.assigneeId) : undefined
      if (next.status === 'failed' && assignee) this.store.addQuestOutcome(assignee.agent.id, 'failed')
      if (next.status === 'failed' && assignee && assignee.agent.id !== (by === 'you' ? '' : by.agent.id)) {
        this.agents.deliver(assignee.agent.id, `[Colony] ${who} cancelled quest ${q.id} "${q.title}". Stop working on it and wait for new instructions.`)
      }
      if (by === 'you') this.notifyOrchestrator(q.projectId, `The commander set quest ${q.id} "${q.title}" to ${next.status}.`)
      if (next.status === 'done') this.onDone(next, undefined)
    }
    this.store.broadcastSnapshot()
    return this.get(id)
  }

  // ── assignment & dependencies ───────────────────────────────────────────────

  unmetDeps(q: Quest): Quest[] {
    return q.dependsOn.map((d) => this.store.quests.get(d)).filter((d): d is Quest => !!d && d.status !== 'done')
  }

  /** Assign a quest. Sends the brief now, or holds it (status blocked) until deps are done. */
  assign(questId: string, agentId: string, projectId: string): { quest: Quest; sent: boolean; waitingOn: string[] } {
    const q = this.inProject(questId, projectId)
    const rec = this.store.agents.get(agentId)
    if (!rec || rec.agent.projectId !== projectId) throw notFound(`agent '${agentId}' in this project`)
    if (rec.agent.role === 'orchestrator') throw badRequest('assign quests to workers, not to the orchestrator')
    if (q.status === 'done') throw conflict(`quest ${q.id} is already done`)
    const unmet = this.unmetDeps(q)
    const status: QuestStatus = unmet.length ? 'blocked' : 'in_progress'
    const next: Quest = { ...q, assigneeId: agentId, status, branch: rec.agent.branch }
    this.store.saveQuest(next)
    if (!unmet.length) this.sendBrief(next, rec)
    this.store.broadcastSnapshot()
    return { quest: next, sent: !unmet.length, waitingOn: unmet.map((d) => d.id) }
  }

  private sendBrief(q: Quest, rec: AgentRecord) {
    const orch = this.orchestratorOf(q.projectId)
    const lines = [
      `[Colony] New quest from ${orch?.agent.callsign ?? 'the commander'}: ${q.id} "${q.title}" (priority ${q.priority})`,
      '',
      q.brief || '(no brief)',
    ]
    if (q.acceptance.length) lines.push('', 'Acceptance criteria:', ...q.acceptance.map((a, i) => `${i}. ${a.text}`))
    if (q.dependsOn.length) lines.push('', `Builds on: ${q.dependsOn.map((d) => `${d} "${this.store.quests.get(d)?.title ?? '?'}"`).join(', ')} (merged to main; start from the latest main).`)
    lines.push('', `Work on your branch ${rec.agent.branch ?? ''}, push it, then call complete_task with quest_id "${q.id}" and a short summary.`)
    this.agents.deliver(rec.agent.id, lines.join('\n'))
    this.store.patchAgent(rec.agent.id, { currentTaskId: q.id })
    this.store.addEvent({
      id: newId('ev'), at: nowIso(), agentId: rec.agent.id, projectId: q.projectId, kind: 'handoff',
      text: `${orch?.agent.callsign ?? 'You'} → ${rec.agent.callsign}: quest "${q.title}"`,
      message: { to: rec.agent.id, body: q.title },
    })
  }

  /** Start blocked quests whose dependencies are now all done. */
  private releaseBlocked(projectId: string) {
    for (const q of this.store.projectQuests(projectId)) {
      if (q.status !== 'blocked' || !q.assigneeId || this.unmetDeps(q).length) continue
      const rec = this.store.agents.get(q.assigneeId)
      if (!rec) continue
      const next: Quest = { ...q, status: 'in_progress' }
      this.store.saveQuest(next)
      this.sendBrief(next, rec)
      this.notifyOrchestrator(projectId, `Quest ${q.id} "${q.title}" was unblocked and sent to ${rec.agent.callsign}.`)
    }
  }

  // ── worker hand-back ─────────────────────────────────────────────────────────

  async complete(questId: string, rec: AgentRecord, summary: string): Promise<Quest> {
    const q = this.inProject(questId, rec.agent.projectId)
    if (q.assigneeId !== rec.agent.id) throw conflict(`quest ${q.id} is not assigned to you`)
    if (q.status === 'done' || q.status === 'failed') throw conflict(`quest ${q.id} is already ${q.status}`)
    if (q.status === 'blocked') throw conflict(`quest ${q.id} is still waiting on ${this.unmetDeps(q).map((d) => d.id).join(', ')}; you will get its brief when they are merged`)
    if (q.status === 'backlog') throw conflict(`quest ${q.id} is not assigned to you yet`)
    const branch = rec.agent.branch
    if (!branch) throw conflict('you have no branch yet')
    const prec = this.store.projects.get(rec.agent.projectId)!
    let info
    try { info = (await this.infra.listBranches(prec.slug)).find((b) => b.name === branch) } catch (e) { throw infraError(e, 'could not read branches') }
    if (!info) throw conflict(`branch ${branch} is not on the git server yet: commit and \`git push origin ${branch}\` first`)
    if (info.aheadOfMain === 0) throw conflict(`branch ${branch} has no commits ahead of main: commit and push your work first`)
    const next: Quest = { ...q, status: 'in_review', branch }
    this.store.saveQuest(next)
    this.store.addEvent({
      id: newId('ev'), at: nowIso(), agentId: rec.agent.id, projectId: q.projectId, kind: 'status',
      text: `Completed quest "${q.title}" → review`,
    })
    this.notifyOrchestrator(q.projectId,
      `${rec.agent.callsign} completed quest ${q.id} "${q.title}" on ${branch} (${info.aheadOfMain} commit${info.aheadOfMain === 1 ? '' : 's'} ahead, ${info.behindMain} behind main).\n` +
      `Their summary: ${summary}\n` +
      `Review it with review_branch, then request_merge or send feedback with message_agent.`)
    this.store.broadcastSnapshot()
    this.onCompleted?.(next, rec, info.sha)
    return next
  }

  progress(rec: AgentRecord, text: string, questId?: string, acceptanceDone?: number[]): Quest | undefined {
    let q: Quest | undefined
    if (questId) {
      q = this.inProject(questId, rec.agent.projectId)
      if (acceptanceDone?.length) {
        const acceptance = q.acceptance.map((a, i) => (acceptanceDone.includes(i) ? { ...a, done: true } : a))
        q = { ...q, acceptance }
        this.store.saveQuest(q)
      }
    }
    this.store.addEvent({ id: newId('ev'), at: nowIso(), agentId: rec.agent.id, projectId: rec.agent.projectId, kind: 'status', text })
    if (q) this.store.broadcastSnapshot()
    return q
  }

  // ── merge outcomes (called by MergeService) ─────────────────────────────────

  onMerged(mr: MergeRequest) {
    const q = this.questFor(mr)
    if (q && q.status !== 'done') this.onDone({ ...q, status: 'done' }, mr)
    else this.notifyOrchestrator(mr.projectId, `The commander approved and Colony merged ${mr.branch} → main.`)
  }

  private onDone(q: Quest, mr: MergeRequest | undefined) {
    this.store.saveQuest({ ...q, status: 'done', acceptance: mr ? q.acceptance.map((a) => ({ ...a, done: true })) : q.acceptance })
    const assignee = q.assigneeId ? this.store.agents.get(q.assigneeId) : undefined
    if (assignee) {
      this.store.addQuestOutcome(assignee.agent.id, 'done')
      this.store.patchAgent(assignee.agent.id, {
        questsDone: assignee.agent.questsDone + 1,
        ...(assignee.agent.currentTaskId === q.id ? { currentTaskId: undefined } : {}),
      })
      this.store.addEvent({
        id: newId('ev'), at: nowIso(), agentId: assignee.agent.id, projectId: q.projectId, kind: 'quest_complete',
        text: `Quest complete: "${q.title}" (+${q.xpReward} XP)`,
      })
      if (mr) this.agents.deliver(assignee.agent.id, `[Colony] Your quest ${q.id} "${q.title}" was merged to main. Before any further work, \`git fetch origin && git rebase origin/main\`.`)
    }
    this.notifyOrchestrator(q.projectId, mr
      ? `The commander approved and Colony merged ${mr.branch} → main, closing quest ${q.id} "${q.title}".`
      : `Quest ${q.id} "${q.title}" is done.`)
    this.releaseBlocked(q.projectId)
  }

  onChangesRequested(mr: MergeRequest, note: string) {
    const q = this.questFor(mr)
    if (q && q.status === 'in_review') this.store.saveQuest({ ...q, status: 'in_progress' })
    const assignee = q?.assigneeId ? this.store.agents.get(q.assigneeId) : undefined
    if (assignee && assignee.agent.id !== mr.requestedBy) {
      this.agents.deliver(assignee.agent.id, `[Colony] The commander requested changes on ${mr.branch}${q ? ` (quest ${q.id})` : ''}:\n${note}\nAddress this, push, and call complete_task again.`)
    }
  }

  onMergeFailed(mr: MergeRequest, conflictHappened: boolean, message: string) {
    const q = this.questFor(mr)
    this.notifyOrchestrator(mr.projectId, conflictHappened
      ? `Merging ${mr.branch} → main hit a conflict${q ? ` (quest ${q.id})` : ''}. Do not resolve it yourself: create a fix quest naming the branch and the conflicting files, and assign it to the worker who knows that area.\n${message.slice(0, 2000)}`
      : `Merging ${mr.branch} → main failed${q ? ` (quest ${q.id})` : ''}: ${message.slice(0, 2000)}`)
  }

  private questFor(mr: MergeRequest): Quest | undefined {
    if (mr.questId) return this.store.quests.get(mr.questId)
    return this.store.projectQuests(mr.projectId).find((q) => q.branch === mr.branch && q.status === 'in_review')
  }

  /** An agent went away: its open quests return to the backlog. */
  onAgentRemoved(agent: Agent) {
    let changed = false
    for (const q of this.store.projectQuests(agent.projectId)) {
      if (q.assigneeId !== agent.id || q.status === 'done' || q.status === 'failed') continue
      const next: Quest = { ...q, status: q.status === 'in_review' ? 'in_review' : 'backlog' }
      if (next.status === 'backlog') delete next.assigneeId
      this.store.saveQuest(next)
      changed = true
    }
    if (changed) this.store.broadcastSnapshot()
  }
}

export function isPriority(v: unknown): v is Priority {
  return typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v)
}
export function isQuestStatus(v: unknown): v is QuestStatus {
  return typeof v === 'string' && (QUEST_STATUSES as readonly string[]).includes(v)
}
