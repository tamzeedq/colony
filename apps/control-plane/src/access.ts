// Local access for the commander (feedback #19): fetch a base's branches into your own checkout,
// and preview a dev server an agent is running. Both are sidecar containers with one port bound
// to 127.0.0.1 (never 0.0.0.0), started on request and removed when closed, when the agent goes,
// or when Colony restarts. Nothing here can write to the repo: the git sidecar has no
// receive-pack and mounts the repo volume read-only.

import { createServer } from 'node:net'
import type { AgentManager } from './agents'
import { conflict, HttpError, infraError, notFound } from './errors'
import type { InfraDriver } from './infra/types'
import type { Store } from './store'

const PORT_MIN = 56500
const PORT_MAX = 56999
const COMMON_DEV_PORTS = [5173, 3000, 8081, 8080, 4321, 19006]

export interface RepoAccess { projectId: string; port: number; url: string; remote: string; commands: string[] }
export interface PreviewAccess { agentId: string; targetPort: number; port: number; url: string }

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '127.0.0.1')
  })
}

/** Ports an agent's recent commands mention (e.g. `--port 8099`, `localhost:5173`), newest first. */
export function suggestPorts(commands: string[]): number[] {
  const out: number[] = []
  for (const cmd of [...commands].reverse()) {
    for (const m of cmd.matchAll(/(?:--port[ =]|-p[ =]?|localhost:|127\.0\.0\.1:|0\.0\.0\.0:)(\d{4,5})\b/g)) {
      const n = Number(m[1])
      if (n >= 1024 && n <= 65535 && !out.includes(n)) out.push(n)
    }
  }
  for (const p of COMMON_DEV_PORTS) if (!out.includes(p)) out.push(p)
  return out.slice(0, 6)
}

export class AccessService {
  private repos = new Map<string, RepoAccess>()
  private previews = new Map<string, PreviewAccess>()

  constructor(private store: Store, private infra: InfraDriver, private agents: AgentManager, private isFree: (p: number) => Promise<boolean> = portFree) {}

  private used() { return new Set([...this.repos.values(), ...this.previews.values()].map((x) => x.port)) }

  private async allocPort(): Promise<number> {
    const used = this.used()
    for (let p = PORT_MIN; p <= PORT_MAX; p++) {
      if (used.has(p)) continue
      if (await this.isFree(p)) return p
    }
    throw conflict(`no free local port in ${PORT_MIN}–${PORT_MAX}`)
  }

  private need<K extends 'exposeRepo' | 'unexposeRepo' | 'startPreview' | 'stopPreview'>(k: K): NonNullable<InfraDriver[K]> {
    const f = this.infra[k]
    if (!f) throw new HttpError(501, 'not_supported', 'local access is not supported by this infrastructure driver')
    return f.bind(this.infra) as NonNullable<InfraDriver[K]>
  }

  // ── repo ──

  repo(projectId: string): RepoAccess | null { return this.repos.get(projectId) ?? null }

  async openRepo(projectId: string): Promise<RepoAccess> {
    const prec = this.store.projects.get(projectId)
    if (!prec) throw notFound('project')
    const existing = this.repos.get(projectId)
    if (existing) return existing
    const port = await this.allocPort()
    try { await this.need('exposeRepo')(prec.slug, port) } catch (e) { throw infraError(e, 'could not open the repo locally') }
    const url = `git://127.0.0.1:${port}/repo.git`
    const remote = `colony-${prec.slug}`
    const access: RepoAccess = {
      projectId, port, url, remote,
      commands: [
        `git remote add ${remote} ${url}`,
        `git fetch ${remote}`,
        `git switch -c review/<branch> ${remote}/<branch>    # e.g. ${remote}/agent/vex-07`,
      ],
    }
    this.repos.set(projectId, access)
    return access
  }

  async closeRepo(projectId: string) {
    const prec = this.store.projects.get(projectId)
    if (!prec) throw notFound('project')
    this.repos.delete(projectId)
    try { await this.need('unexposeRepo')(prec.slug) } catch (e) { throw infraError(e, 'could not close local repo access') }
    return { ok: true }
  }

  // ── preview ──

  preview(agentId: string) {
    const rec = this.agents.get(agentId)
    const cmds = this.store.agentEvents(agentId, 200).filter((e) => e.kind === 'command' && e.command?.cmd).map((e) => e.command!.cmd)
    return { active: this.previews.get(rec.agent.id) ?? null, suggestedPorts: suggestPorts(cmds) }
  }

  async startPreview(agentId: string, targetPort: number): Promise<PreviewAccess> {
    const rec = this.agents.get(agentId)
    const prec = this.store.projects.get(rec.agent.projectId)
    if (!prec) throw notFound('project')
    if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) throw new HttpError(400, 'bad_request', 'port must be 1024–65535')
    if (rec.agent.status === 'error' || rec.agent.status === 'done') throw conflict(`${rec.agent.callsign}'s container isn't running`)
    const prev = this.previews.get(rec.agent.id)
    if (prev && prev.targetPort === targetPort) return prev
    const port = prev?.port ?? await this.allocPort()
    try { await this.need('startPreview')(prec.slug, rec.agent.id, targetPort, port) } catch (e) { throw infraError(e, 'could not start the preview') }
    const access: PreviewAccess = { agentId: rec.agent.id, targetPort, port, url: `http://127.0.0.1:${port}/` }
    this.previews.set(rec.agent.id, access)
    return access
  }

  async stopPreview(agentId: string) {
    this.previews.delete(agentId)
    try { await this.need('stopPreview')(agentId) } catch (e) { throw infraError(e, 'could not stop the preview') }
    return { ok: true }
  }

  /** The agent was removed: its preview goes with it (best effort). */
  onAgentRemoved(agentId: string) {
    if (!this.previews.has(agentId)) return
    this.previews.delete(agentId)
    void this.infra.stopPreview?.(agentId).catch(() => {})
  }

  /** On boot: remove sidecars left by a previous run (they're opened on request only). */
  async cleanupLeftovers() {
    try {
      for (const c of await this.infra.listContainers()) {
        if (c.name.startsWith('colony-preview-')) await this.infra.stopPreview?.(c.name.slice('colony-preview-'.length)).catch(() => {})
        else if (c.name.startsWith('colony-repo-')) await this.infra.unexposeRepo?.(c.name.slice('colony-repo-'.length)).catch(() => {})
      }
    } catch { /* docker down: nothing to clean */ }
  }
}
