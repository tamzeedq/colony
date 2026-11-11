// Checkpoints and revert for agent branches (docs/phase6.md §2). Checkpoints are refs in the
// project's bare repo; a revert moves only the agent's own branch, after saving a backup ref,
// then syncs the agent's working tree. main is never touched (the driver refuses, and the
// pre-receive hook still protects it).

import type { Quest } from '@colony/shared'
import type { AgentManager } from './agents'
import type { Db } from './db'
import { badRequest, conflict, HttpError, infraError } from './errors'
import { RefRejectedError, type CommitInfo, type InfraDriver } from './infra/types'
import { SHA_RE } from './infra/validate'
import { newId, nowIso, type AgentRecord, type Store } from './store'

export interface CheckpointView { ref: string; sha: string; at: string; label: string }
export interface CommitView extends CommitInfo { checkpoint?: string; backup?: boolean }

const BUSY = new Set(['running', 'editing', 'thinking'])
const LABELS_KEY = (agentId: string) => `checkpoint_labels:${agentId}`

export class CheckpointService {
  constructor(private store: Store, private db: Db, private infra: InfraDriver, private agents: AgentManager) {}

  private ctx(agentId: string) {
    const rec = this.agents.get(agentId)
    const prec = this.store.projects.get(rec.agent.projectId)
    if (!prec) throw new HttpError(404, 'not_found', 'project not found')
    const branch = rec.agent.branch
    if (!branch) throw conflict('this agent has no branch yet')
    const d = this.infra
    if (!d.branchLog || !d.listRefs || !d.setRef || !d.resetBranch) throw new HttpError(501, 'not_supported', 'checkpoints are not supported by this infrastructure driver')
    return { rec, slug: prec.slug, branch, d: d as Required<Pick<InfraDriver, 'branchLog' | 'listRefs' | 'setRef' | 'resetBranch'>> & InfraDriver }
  }

  private labels(agentId: string): Record<string, string> {
    return this.db.kvGet<Record<string, string>>(LABELS_KEY(agentId)) ?? {}
  }

  private async head(slug: string, branch: string): Promise<string | undefined> {
    try {
      return (await this.infra.listBranches(slug)).find((b) => b.name === branch)?.sha
    } catch (e) { throw infraError(e, 'could not read branches') }
  }

  async checkpoints(agentId: string): Promise<CheckpointView[]> {
    const { rec, slug, d } = this.ctx(agentId)
    const labels = this.labels(agentId)
    let refs
    try { refs = await d.listRefs(slug, `refs/colony/checkpoints/${rec.agent.id}/`) } catch (e) { throw infraError(e, 'could not list checkpoints') }
    return refs.map((r) => {
      const ts = r.ref.split('/').pop()!
      return { ref: r.ref, sha: r.sha, at: new Date(Number(ts)).toISOString(), label: labels[r.ref] ?? 'Checkpoint' }
    }).sort((a, b) => b.at.localeCompare(a.at))
  }

  /** Last 30 commits on the agent's branch, newest first, with checkpoint labels. */
  async commits(agentId: string): Promise<{ branch: string; commits: CommitView[]; checkpoints: CheckpointView[]; lastBackup?: { sha: string; at: string } }> {
    const { rec, slug, branch, d } = this.ctx(agentId)
    if (!(await this.head(slug, branch))) return { branch, commits: [], checkpoints: [] }
    let log: CommitInfo[]
    try { log = await d.branchLog(slug, branch, 30) } catch (e) { throw infraError(e, 'could not read the branch history') }
    const cps = await this.checkpoints(agentId)
    const bySha = new Map<string, string>()
    for (const c of [...cps].reverse()) bySha.set(c.sha, c.label)
    const lastBackup = await this.lastBackup(rec.agent.id, slug)
    return {
      branch,
      commits: log.map((c) => ({ ...c, ...(bySha.has(c.sha) ? { checkpoint: bySha.get(c.sha) } : {}) })),
      checkpoints: cps,
      ...(lastBackup ? { lastBackup } : {}),
    }
  }

  private async lastBackup(agentId: string, slug: string) {
    const refs = await this.infra.listRefs!(slug, `refs/colony/backup/${agentId}/`).catch(() => [])
    const last = refs.map((r) => ({ sha: r.sha, ts: Number(r.ref.split('/').pop()) })).sort((a, b) => b.ts - a.ts)[0]
    return last ? { sha: last.sha, at: new Date(last.ts).toISOString() } : undefined
  }

  /** Record a checkpoint at the branch head (or `sha`). */
  async create(agentId: string, label = 'Checkpoint', sha?: string): Promise<CheckpointView> {
    const { rec, slug, branch, d } = this.ctx(agentId)
    const at = sha ?? (await this.head(slug, branch))
    if (!at) throw conflict(`branch ${branch} is not on the git server yet`)
    const ts = this.uniqueTs()
    const ref = `refs/colony/checkpoints/${rec.agent.id}/${ts}`
    try { await d.setRef(slug, ref, at) } catch (e) { throw infraError(e, 'could not save the checkpoint') }
    const labels = this.labels(agentId)
    labels[ref] = label.slice(0, 120)
    this.db.kvSet(LABELS_KEY(agentId), labels)
    return { ref, sha: at, at: new Date(ts).toISOString(), label: labels[ref] }
  }

  private lastTs = 0
  private uniqueTs() {
    const t = Math.max(Date.now(), this.lastTs + 1)
    this.lastTs = t
    return t
  }

  /** Hook for QuestService.onCompleted. Best effort: a failure never blocks the quest. */
  onQuestCompleted(quest: Quest, rec: AgentRecord, sha: string) {
    this.create(rec.agent.id, `Quest "${quest.title}" completed`, sha).catch(() => {})
  }

  /** Move the agent's branch back to `to` (or `count` commits back). */
  async revert(agentId: string, input: { to?: string; count?: number; force?: boolean }) {
    const { rec, slug, branch, d } = this.ctx(agentId)
    if (BUSY.has(rec.agent.status) && !input.force) {
      throw conflict(`${rec.agent.callsign} is ${rec.agent.status}; pause it first (or send force: true)`)
    }
    const from = await this.head(slug, branch)
    if (!from) throw conflict(`branch ${branch} is not on the git server yet`)
    let to = input.to
    if (to === undefined) {
      const n = input.count
      if (!Number.isInteger(n) || n! < 1 || n! > 50) throw badRequest("send 'to' (a commit sha) or 'count' (1–50)")
      const log = await d.branchLog(slug, branch, n! + 1).catch((e) => { throw infraError(e, 'could not read the branch history') })
      if (log.length <= n!) throw conflict(`branch ${branch} has only ${log.length} commit${log.length === 1 ? '' : 's'}`)
      to = log[n!].sha
    }
    if (!SHA_RE.test(to)) throw badRequest("'to' must be a full 40-character commit sha")
    if (to === from) throw conflict(`branch ${branch} is already at ${to.slice(0, 12)}`)
    // Undo: a backup this agent's branch had is always allowed, even though it is not an ancestor.
    const backups = await d.listRefs(slug, `refs/colony/backup/${rec.agent.id}/`).catch(() => [])
    const isUndo = backups.some((b) => b.sha === to)
    const backupRef = `refs/colony/backup/${rec.agent.id}/${this.uniqueTs()}`
    try {
      await d.resetBranch(slug, branch, { to, expect: from, backupRef, allowAnyTarget: isUndo })
    } catch (e) {
      if (e instanceof RefRejectedError || (e as Error).name === 'RefRejectedError') throw conflict(`revert refused: ${(e as Error).message}`)
      throw infraError(e, 'revert failed')
    }
    const synced = await this.syncWorkspace(rec, branch)
    const short = to.slice(0, 12)
    this.agents.message(rec.agent.id,
      `[Colony] The commander ${isUndo ? 'restored' : 'reverted'} your branch ${branch} to ${short}. ` +
      (synced ? 'Your working tree now matches it; re-read files before continuing.' : `Run \`git fetch origin && git reset --hard origin/${branch}\` before continuing; uncommitted changes from before the revert are gone.`))
    this.store.addEvent({
      id: newId('ev'), at: nowIso(), agentId: rec.agent.id, projectId: rec.agent.projectId, kind: 'status',
      text: `${isUndo ? 'Restored' : 'Reverted'} ${branch} ${from.slice(0, 7)} → ${to.slice(0, 7)} (backup ${backupRef.split('/').pop()})`,
    })
    return { from, to, backupRef, undo: isUndo, workspaceSynced: synced }
  }

  /** Make the agent's working tree match the moved branch, if its container is running. */
  private async syncWorkspace(rec: AgentRecord, branch: string): Promise<boolean> {
    if (!this.infra.execInAgent) return false
    try {
      const r = await this.infra.execInAgent(rec.agent.id, [
        'sh', '-c', 'cd /workspace && git fetch --quiet origin && git checkout --quiet "$1" && git reset --quiet --hard "origin/$1" && git clean -fdq', 'colony', branch,
      ], { timeoutMs: 60_000 })
      return r.exitCode === 0
    } catch { return false }
  }
}
