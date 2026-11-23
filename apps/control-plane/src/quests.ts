// Quests and teamwork (docs/phase3.md): the quest lifecycle, dependencies, and the
// `[Colony]` notifications that keep the orchestrator informed. Used by both the MCP tools
// (agents) and the REST routes (the commander).

import type { AcceptanceCheck, AcceptanceItem, Agent, MergeRequest, Quest, QuestStatus } from '@colony/shared'
import type { AgentManager } from './agents'
import { badRequest, conflict, infraError, notFound } from './errors'
import type { InfraDriver } from './infra/types'
import { newId, nowIso, type AgentRecord, type Store } from './store'

export const QUEST_STATUSES = ['backlog', 'in_progress', 'in_review', 'done', 'failed', 'blocked'] as const satisfies readonly QuestStatus[]
const PRIORITIES = ['low', 'normal', 'high'] as const
type Priority = (typeof PRIORITIES)[number]

/** An acceptance criterion as given by the orchestrator or commander: text, optionally who checks it. */
export type AcceptanceInput = string | { text: string; check?: AcceptanceCheck }

export interface QuestInput {
  title: string
  brief?: string
  why?: string
  acceptance?: AcceptanceInput[]
  priority?: Priority
  dependsOn?: string[]
}

export interface QuestPatch {
  title?: string
  brief?: string
  why?: string
  acceptance?: AcceptanceInput[]
  priority?: Priority
  dependsOn?: string[]
  status?: QuestStatus
}

/** "[human] text" / "[agent] text" prefixes are accepted as a shorthand for `check`. */
export function toAcceptance(input: AcceptanceInput): { text: string; check: AcceptanceCheck } {
  const raw = typeof input === 'string' ? { text: input } : input
  let text = raw.text.trim()
  let check: AcceptanceCheck = raw.check === 'human' ? 'human' : 'agent'
  const m = /^\[(human|agent)\]\s*/i.exec(text)
  if (m) { if (typeof input === 'string' || !raw.check) check = m[1].toLowerCase() as AcceptanceCheck; text = text.slice(m[0].length) }
  return { text, check }
}

const isAgentCheck = (a: AcceptanceItem) => (a.check ?? 'agent') === 'agent'

const XP_BY_PRIORITY: Record<Priority, number> = { low: 60, normal: 100, high: 150 }

/** XP needed per level; the remainder carries over. */
export const XP_PER_LEVEL = 300

export function applyXp(level: number, xp: number, reward: number): { level: number; xp: number; leveledUp: boolean } {
  let total = Math.max(0, xp) + Math.max(0, reward)
  let lv = Math.max(1, level)
  const start = lv
  while (total >= XP_PER_LEVEL) { total -= XP_PER_LEVEL; lv++ }
  return { level: lv, xp: total, leveledUp: lv > start }
}

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

  /** "Let the Orchestrator decide" in Spawn: ask the orchestrator to choose a worker's class and
   *  model and spawn it with spawn_agent. The commander's callsign/cap/starting quest are passed on. */
  requestWorker(projectId: string, input: { callsign?: string; budgetCapUsd?: number; task?: string; iconSeed?: string }) {
    const prec = this.store.projects.get(projectId)
    if (!prec) throw notFound('project')
    const o = this.orchestratorOf(projectId)
    if (!o) throw conflict('this base has no orchestrator yet: spawn one first, or pick a class yourself')
    const callsign = input.callsign?.trim()
    if (callsign && this.store.callsignTaken(callsign)) throw conflict(`callsign ${callsign} is taken`)
    // Keep the emblem the commander saw in Spawn for when the orchestrator spawns this callsign.
    if (callsign && input.iconSeed) this.agents.pendingIconSeeds.set(callsign.toLowerCase(), input.iconSeed)
    const lines = [
      'The commander wants one more worker on this base and asked you to choose its class (role) and model.',
      'Pick what the current plan needs most right now (see list_tasks and list_agents), keeping the team small and the model as cheap as the work allows.',
      `Spawn it with spawn_agent${callsign ? ` using callsign "${callsign}"` : ''}${input.budgetCapUsd ? ` and budget_cap_usd ${input.budgetCapUsd}` : ''}.`,
      input.task
        ? `Its first quest, from the commander: "${input.task}". Create it with create_task and pass its quest_id to spawn_agent.`
        : 'Give it the most useful open quest (pass quest_id to spawn_agent), or create one if the backlog is empty.',
      'Then tell the commander in one or two sentences which class and model you chose and why.',
    ]
    this.agents.deliver(o.agent.id, `[Colony] ${lines.join(' ')}`)
    this.store.addEvent({
      id: newId('ev'), at: nowIso(), agentId: o.agent.id, projectId, kind: 'message',
      text: `You → ${o.agent.callsign}: choose and spawn a worker${callsign ? ` (${callsign})` : ''}${input.task ? ` for "${input.task.slice(0, 80)}"` : ''}`,
      message: { to: o.agent.id, body: lines.join(' ') },
    })
    return { orchestratorId: o.agent.id, orchestrator: o.agent.callsign, delivered: this.agents.isConnected(o.agent.id) }
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
      acceptance: (input.acceptance ?? []).map((x) => ({ ...toAcceptance(x), done: false })),
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
      // Keep verification state for criteria whose text is unchanged.
      const old = new Map(q.acceptance.map((a) => [a.text, a]))
      next.acceptance = input.acceptance.map((x) => {
        const n = toAcceptance(x)
        const prev = old.get(n.text)
        return prev && (prev.check ?? 'agent') === n.check ? prev : { ...n, done: false }
      })
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
    if (q.acceptance.length) {
      lines.push('', 'Acceptance criteria:', ...q.acceptance.map((a, i) => `${i}. ${a.text}${isAgentCheck(a) ? '' : ' (the commander checks this one)'}`))
      lines.push('A QA agent will verify the agent-checkable criteria on your branch before review, so make them pass and say how to check them in your complete_task summary.')
    }
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
        // A worker's own report is a claim, not a verification (QA or the commander verifies).
        const acceptance = q.acceptance.map((a, i) => (acceptanceDone.includes(i) ? { ...a, claimed: true } : a))
        q = { ...q, acceptance }
        this.store.saveQuest(q)
      }
    }
    this.store.addEvent({ id: newId('ev'), at: nowIso(), agentId: rec.agent.id, projectId: rec.agent.projectId, kind: 'status', text })
    if (q) this.store.broadcastSnapshot()
    return q
  }

  // ── acceptance verification (feedback #11) ──────────────────────────────────

  /** Agent-checkable criteria not yet verified as passing, with their indices. */
  unverified(q: Quest): { index: number; text: string; failed: boolean }[] {
    return q.acceptance.flatMap((a, index) => (isAgentCheck(a) && !(a.verification?.result === 'pass')
      ? [{ index, text: a.text, failed: a.verification?.result === 'fail' }] : []))
  }

  /** Orchestrator asks a QA worker to verify a completed quest's agent-checkable criteria. */
  requestVerification(questId: string, verifierId: string, projectId: string) {
    const q = this.inProject(questId, projectId)
    if (q.status !== 'in_review') throw conflict(`quest ${q.id} is ${q.status}; verification is for completed quests (in_review)`)
    const v = this.store.agents.get(verifierId)
    if (!v || v.agent.projectId !== projectId) throw notFound('agent')
    if (v.agent.role === 'orchestrator') throw badRequest('pick a worker (ideally a qa agent) to verify, not the orchestrator')
    if (v.agent.id === q.assigneeId) throw badRequest(`${v.agent.callsign} wrote this quest; another worker should verify it`)
    const items = q.acceptance.map((a, i) => ({ a, i })).filter(({ a }) => isAgentCheck(a))
    if (!items.length) throw conflict(`quest ${q.id} has no agent-checkable criteria; the commander verifies it in review`)
    const next: Quest = {
      ...q, verifierId: v.agent.id,
      // A fresh verification round: earlier results no longer count.
      acceptance: q.acceptance.map((a) => (isAgentCheck(a) ? { ...a, done: false, verification: undefined } : a)),
    }
    this.store.saveQuest(next)
    const author = q.assigneeId ? this.store.agents.get(q.assigneeId)?.agent.callsign : undefined
    this.agents.deliver(v.agent.id, [
      `[Colony] Verification request: quest ${q.id} "${q.title}"${author ? ` by ${author}` : ''}, branch ${q.branch ?? '?'}.`,
      '',
      `Check out that branch in your workspace (git fetch origin && git checkout -B verify-${q.id} origin/${q.branch ?? ''}) and verify each criterion below by actually running the checks (tests, typecheck, lint, scripts, grep, a headless browser run). Do not fix the code: you are verifying, not implementing.`,
      'For EACH criterion call verify_acceptance with quest_id, index, result ("pass" or "fail") and short evidence (the command you ran and what it showed).',
      '',
      ...items.map(({ a, i }) => `${i}. ${a.text}`),
      '',
      'Criteria marked for the commander are not yours to check. When you have verified all of the above, reply with a one-line summary.',
    ].join('\n'))
    this.store.patchAgent(v.agent.id, { currentTaskId: q.id })
    this.store.addEvent({
      id: newId('ev'), at: nowIso(), agentId: v.agent.id, projectId, kind: 'handoff',
      text: `Verify quest "${q.title}" (${items.length} criteria)`, message: { to: v.agent.id, body: `verify ${q.id}` },
    })
    this.store.broadcastSnapshot()
    return { quest: next, verifier: v.agent.callsign, criteria: items.length }
  }

  /** Record a verification result: the assigned QA verifier (or orchestrator) for agent criteria. */
  verify(questId: string, index: number, result: 'pass' | 'fail', evidence: string, by: AgentRecord) {
    const q = this.inProject(questId, by.agent.projectId)
    const a = q.acceptance[index]
    if (!a) throw badRequest(`quest ${q.id} has no criterion ${index} (0–${q.acceptance.length - 1})`)
    if (!isAgentCheck(a)) throw conflict(`criterion ${index} is for the commander to check, not an agent`)
    const isVerifier = q.verifierId === by.agent.id
    if (!isVerifier && by.agent.role !== 'orchestrator') throw conflict(`you are not the verifier for quest ${q.id}`)
    const acceptance = q.acceptance.map((x, i) => (i === index
      ? { ...x, done: result === 'pass', verification: { by: by.agent.id, result, evidence: evidence.slice(0, 2000), at: nowIso() } }
      : x))
    const next: Quest = { ...q, acceptance }
    this.store.saveQuest(next)
    this.store.addEvent({
      id: newId('ev'), at: nowIso(), agentId: by.agent.id, projectId: q.projectId, kind: 'test',
      text: `${result === 'pass' ? '✓' : '✕'} ${q.title} · criterion ${index}: ${a.text}${evidence ? ` — ${evidence.slice(0, 200)}` : ''}`,
      test: { passed: result === 'pass' ? 1 : 0, failed: result === 'fail' ? 1 : 0, running: 0 },
    })
    // All agent criteria have a result: tell the orchestrator once.
    const agentItems = acceptance.filter(isAgentCheck)
    if (agentItems.every((x) => x.verification)) {
      const failed = acceptance.map((x, i) => ({ x, i })).filter(({ x }) => isAgentCheck(x) && x.verification?.result === 'fail')
      const humans = acceptance.filter((x) => !isAgentCheck(x)).length
      this.notifyOrchestrator(q.projectId, failed.length
        ? `${by.agent.callsign} verified quest ${q.id} "${q.title}": ${failed.length} criteria FAILED (${failed.map(({ x, i }) => `${i}. ${x.text}: ${x.verification?.evidence ?? ''}`).join('; ')}). Send it back to the worker with message_agent, then request verification again once fixed.`
        : `${by.agent.callsign} verified quest ${q.id} "${q.title}": all ${agentItems.length} agent-checkable criteria pass.${humans ? ` ${humans} criteria are for the commander to check in review.` : ''} You can request_merge now.`)
    }
    this.store.broadcastSnapshot()
    return next
  }

  /** The commander ticks (or unticks) a criterion. Works for any criterion; marks it verified by you. */
  commanderCheck(questId: string, index: number, done: boolean) {
    const q = this.get(questId)
    const a = q.acceptance[index]
    if (!a) throw badRequest(`quest ${q.id} has no criterion ${index}`)
    const acceptance = q.acceptance.map((x, i) => (i === index
      ? (done ? { ...x, done: true, verification: { by: 'you' as const, result: 'pass' as const, at: nowIso() } } : { ...x, done: false, verification: undefined })
      : x))
    const next: Quest = { ...q, acceptance }
    this.store.saveQuest(next)
    this.store.broadcastSnapshot()
    return next
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
      const prog = applyXp(assignee.agent.level, assignee.agent.xp, q.xpReward)
      this.store.patchAgent(assignee.agent.id, {
        questsDone: assignee.agent.questsDone + 1,
        level: prog.level, xp: prog.xp,
        ...(assignee.agent.currentTaskId === q.id ? { currentTaskId: undefined } : {}),
      })
      this.store.addEvent({
        id: newId('ev'), at: nowIso(), agentId: assignee.agent.id, projectId: q.projectId, kind: 'quest_complete',
        text: `Quest complete: "${q.title}" (+${q.xpReward} XP)${prog.leveledUp ? ` · Level ${prog.level}` : ''}`,
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
