// Project creation/removal and merge requests.

import { canMergeToMain, type MergeRequest, type Project } from '@colony/shared'
import type { AgentManager } from './agents'
import type { Config } from './config'
import { conflict, HttpError, infraError, notFound } from './errors'
import type { InfraDriver, MergeResult } from './infra/types'
import type { QuestService } from './quests'
import { newId, nowIso, type Store } from './store'

export interface CreateProjectInput {
  name: string
  goal?: string
  stack?: string[]
  repoUrl?: string
  dailyCapUsd?: number
}

export class ProjectService {
  constructor(private store: Store, private infra: InfraDriver, private agents: AgentManager, private config: Config) {}

  get(id: string) {
    const p = this.store.projects.get(id)
    if (!p) throw notFound('project')
    return p
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const slug = this.store.uniqueSlug(input.name)
    try {
      await this.infra.ensureProject(slug, { repoUrl: input.repoUrl, projectName: input.name })
    } catch (e) {
      throw infraError(e, 'failed to create project infrastructure')
    }
    const project: Project = {
      id: newId(`p-${slug}`),
      key: this.store.nextKey(),
      name: input.name,
      ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
      stack: input.stack ?? [],
      goal: input.goal ?? '',
      health: { score: 0, label: 'dormant' },
      supabase: { status: 'none' },
      agentIds: [],
      spendTodayUsd: 0,
      dailyCapUsd: input.dailyCapUsd ?? this.config.defaultProjectDailyCapUsd,
      sessionShare: 0,
      unreadAlerts: 0,
    }
    const rec = { project, slug, createdAt: nowIso() }
    this.store.saveProject(rec)
    this.store.broadcastSnapshot()
    return this.store.toProject(rec)
  }

  /** Update goal and/or daily cap. A new goal is forwarded to the orchestrator, if any. */
  patch(id: string, input: { goal?: string; dailyCapUsd?: number }) {
    const rec = this.get(id)
    const p = rec.project
    const goalChanged = input.goal !== undefined && input.goal !== p.goal
    rec.project = {
      ...p,
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.dailyCapUsd !== undefined ? { dailyCapUsd: input.dailyCapUsd } : {}),
    }
    this.store.saveProject(rec)
    let forwardedTo: string | undefined
    if (goalChanged && input.goal) {
      const orch = this.store.projectAgents(id).find((a) => a.agent.role === 'orchestrator')
      if (orch) {
        this.agents.message(orch.agent.id, `New goal from the commander: ${input.goal}`)
        forwardedTo = orch.agent.id
      }
    }
    this.store.broadcastSnapshot()
    return { project: this.store.toProject(rec), forwardedTo }
  }

  async remove(id: string, opts: { purge?: boolean } = {}) {
    const rec = this.get(id)
    for (const a of this.store.projectAgents(id)) await this.agents.kill(a.agent.id, opts)
    try {
      await this.infra.removeProject(rec.slug, { purge: opts.purge })
    } catch (e) {
      throw infraError(e, 'failed to remove project infrastructure')
    }
    this.store.deleteProject(id)
    this.store.broadcastSnapshot()
    return { ok: true, id }
  }

  async branches(id: string) {
    const rec = this.get(id)
    try { return await this.infra.listBranches(rec.slug) } catch (e) { throw infraError(e, 'infra error') }
  }

  async diff(id: string, branch: string) {
    const rec = this.get(id)
    try { return await this.infra.diff(rec.slug, branch) } catch (e) { throw infraError(e, 'infra error') }
  }
}

export interface CreateMergeRequestInput {
  projectId: string
  branch: string
  requestedBy?: string
  prNumber?: number
  questId?: string
  summary?: string
}

export class MergeService {
  /** Set by the app once the quest service exists (merge outcomes move quests). */
  quests?: QuestService

  constructor(private store: Store, private infra: InfraDriver, private agents?: AgentManager) {}

  get(id: string) {
    const mr = this.store.mergeRequests.get(id)
    if (!mr) throw notFound('merge request')
    return mr
  }

  private alertId(mrId: string) { return `al-${mrId}` }

  /** Open a merge request. Approval fields can never be set here. */
  create(input: CreateMergeRequestInput): MergeRequest {
    const prec = this.store.projects.get(input.projectId)
    if (!prec) throw notFound('project')
    const requestedBy = input.requestedBy ?? 'you'
    if (requestedBy !== 'you' && !this.store.agents.has(requestedBy)) throw notFound('requesting agent')
    const mr: MergeRequest = {
      id: newId('mr'), projectId: input.projectId, branch: input.branch, requestedBy, status: 'pending',
      ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
      ...(input.questId ? { questId: input.questId } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
    }
    this.store.saveMergeRequest(mr)
    const who = requestedBy === 'you' ? undefined : this.store.agents.get(requestedBy)
    this.store.raiseAlert({
      id: this.alertId(mr.id), kind: 'approval', severity: 'needs_you', projectId: mr.projectId, agentId: who?.agent.id,
      title: `Merge ${mr.branch} → main?${mr.prNumber ? ` (PR #${mr.prNumber})` : ''}`,
      ...(mr.summary ? { detail: mr.summary } : {}),
      actions: [{ id: 'approve', label: '✓ Approve & merge', primary: true, actsAsYou: true }, { id: 'review', label: 'Open review' }],
    })
    this.store.broadcastSnapshot()
    return mr
  }

  /** The commander approves (recorded), then Colony merges. */
  async approve(id: string): Promise<{ mergeRequest: MergeRequest; result: MergeResult }> {
    const mr = this.get(id)
    if (mr.status === 'merged') throw conflict('merge request is already merged')
    const approved: MergeRequest = { ...mr, status: 'approved', approvedBy: 'you', approvedAt: nowIso() }
    this.store.saveMergeRequest(approved)
    return this.merge(approved.id)
  }

  /** The commander sends the branch back: status changes_requested, the note goes to the
   *  requesting agent (queued if its runner is offline), and the approval alert is resolved. */
  requestChanges(id: string, note: string): MergeRequest {
    const mr = this.get(id)
    if (mr.status === 'merged') throw conflict('merge request is already merged')
    const next: MergeRequest = { ...mr, status: 'changes_requested' }
    delete next.approvedBy
    delete next.approvedAt
    this.store.saveMergeRequest(next)
    this.store.resolveAlert(this.alertId(mr.id))
    if (mr.requestedBy !== 'you' && this.store.agents.has(mr.requestedBy) && this.agents) {
      this.agents.message(mr.requestedBy,
        `The commander requested changes on your merge request for ${mr.branch} → main:\n${note}\n\n` +
        `Address this, push to ${mr.branch}, and request the merge again.`)
    }
    this.quests?.onChangesRequested(next, note)
    this.store.broadcastSnapshot()
    return next
  }

  /** Merge an approved request. Refuses unless canMergeToMain() passes. */
  async merge(id: string): Promise<{ mergeRequest: MergeRequest; result: MergeResult }> {
    const mr = this.get(id)
    if (!canMergeToMain(mr)) throw new HttpError(403, 'not_approved', 'merging to main requires a recorded human approval')
    const prec = this.store.projects.get(mr.projectId)
    if (!prec) throw notFound('project')
    let result: MergeResult
    try {
      result = await this.infra.mergeToMain(prec.slug, mr.branch, `Merge ${mr.branch} (approved by you at ${mr.approvedAt})`)
    } catch (e) {
      result = { ok: false, conflict: false, message: (e as Error).message }
    }
    if (result.ok) {
      const merged: MergeRequest = { ...mr, status: 'merged' }
      this.store.saveMergeRequest(merged)
      this.store.resolveAlert(this.alertId(mr.id))
      this.quests?.onMerged(merged)
      this.store.broadcastSnapshot()
      return { mergeRequest: merged, result }
    }
    this.store.raiseAlert({
      kind: 'approval', severity: 'needs_you', projectId: mr.projectId,
      title: result.conflict ? `Merge conflict: ${mr.branch} → main` : `Merge of ${mr.branch} failed`,
      detail: result.message,
      actions: [{ id: 'review', label: 'Open review', primary: true }, { id: 'dismiss', label: 'Dismiss' }],
    })
    this.quests?.onMergeFailed(mr, result.conflict, result.message)
    this.store.broadcastSnapshot()
    throw new HttpError(result.conflict ? 409 : 502, result.conflict ? 'merge_conflict' : 'merge_failed', result.message, { mergeRequest: mr })
  }
}
