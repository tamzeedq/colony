// Boot reconciliation with Docker, and the 5 s stats poller.

import type { Agent } from '@colony/shared'
import type { AgentManager } from './agents'
import type { InfraDriver } from './infra/types'
import type { Store } from './store'

type Log = { info: (m: string) => void; warn: (m: string) => void }

export interface ReconcileOptions {
  /** Restart agents whose container stopped or vanished while they were meant to run (docs/phase6.md). */
  autoResume?: boolean
}

/** Adopt running agents (await their runner). Agents whose container is gone are resumed when
 *  they were meant to run, otherwise marked as error with a crash alert. Git servers are
 *  (re)started first, since a Docker restart stops them too. */
export async function reconcile(store: Store, infra: InfraDriver, agents: AgentManager, log: Log, opts: ReconcileOptions = {}) {
  store.dockerUp = await infra.ping().catch(() => false)
  if (!store.dockerUp) {
    log.warn('docker is not reachable; skipping reconciliation')
    store.broadcastResources()
    return
  }
  let containers
  try {
    containers = await infra.listContainers()
  } catch (e) {
    log.warn(`listContainers failed: ${(e as Error).message}`)
    return
  }
  for (const p of store.projects.values()) {
    try {
      await infra.ensureProject(p.slug, { repoUrl: p.project.repoUrl, projectName: p.project.name })
    } catch (e) {
      log.warn(`could not ensure project ${p.slug}: ${(e as Error).message}`)
    }
  }
  const byAgent = new Map(containers.filter((c) => c.kind === 'agent' && c.agentId).map((c) => [c.agentId!, c]))
  store.runningContainers = containers.filter((c) => c.kind === 'agent' && c.running).length

  for (const rec of store.agents.values()) {
    const id = rec.agent.id
    const c = byAgent.get(id)
    if (c?.running) {
      store.patchAgent(id, { container: { ...rec.agent.container, name: c.name, health: 'ok' } })
      agents.expectReconnect(id)
      log.info(`adopted running agent ${id}`)
    } else if (rec.agent.status !== 'error' && rec.agent.status !== 'done' && opts.autoResume && rec.internal.desired === 'run') {
      try {
        await agents.restart(id)
        // One alert per agent: a later restart refreshes it instead of stacking duplicates.
        store.raiseAlert({
          id: `al-resumed-${id}`,
          kind: 'crash', severity: 'heads_up', projectId: rec.agent.projectId, agentId: id,
          title: `${rec.agent.callsign} resumed after restart`,
          detail: `Its container was ${c ? 'stopped' : 'missing'} when Colony started; it was restarted on its workspace and continues its session.`,
        })
        log.info(`resumed agent ${id} (container ${c ? 'stopped' : 'missing'})`)
      } catch (e) {
        log.warn(`could not resume ${id}: ${(e as Error).message}`)
      }
    } else if (rec.agent.status !== 'error') {
      store.patchAgent(id, {
        status: 'error', currentAction: c ? 'Container stopped' : 'Container missing',
        container: { ...rec.agent.container, ...(c ? { name: c.name } : {}), health: 'down', cpuPct: 0, memMb: 0 },
      })
      store.raiseAlert({
        kind: 'crash', severity: 'critical', projectId: rec.agent.projectId, agentId: id,
        title: `${rec.agent.callsign}'s container is ${c ? 'stopped' : 'missing'}`,
        detail: 'Found while reconciling after a control-plane restart.',
        actions: [{ id: 'restart', label: '↻ Restart', primary: true }],
      })
    }
  }
  for (const c of byAgent.values()) {
    if (!store.agents.has(c.agentId!)) log.warn(`container ${c.name} belongs to unknown agent ${c.agentId}; leaving it alone`)
  }
  store.broadcastResources()
}

export class StatsPoller {
  private timer: NodeJS.Timeout | undefined
  private busy = false
  private wasUp: boolean | undefined
  /** Called when Docker becomes reachable again after being down (re-run reconcile). */
  onDockerBack?: () => Promise<void>
  /** Called on every tick (plan-usage rollover). */
  onTick?: () => void

  constructor(private store: Store, private infra: InfraDriver, private intervalMs: number, private log: Log) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      this.store.rollDayIfNeeded()
      try { this.onTick?.() } catch (e) { this.log.warn(`tick hook failed: ${(e as Error).message}`) }
      this.store.sampleHost()
      this.store.dockerUp = await this.infra.ping().catch(() => false)
      const back = this.wasUp === false && this.store.dockerUp
      this.wasUp = this.store.dockerUp
      if (back && this.onDockerBack) {
        this.log.info('docker is reachable again; reconciling')
        await this.onDockerBack().catch((e) => this.log.warn(`reconcile after docker came back: ${(e as Error).message}`))
      }
      let running = 0
      if (this.store.dockerUp) {
        for (const rec of [...this.store.agents.values()]) {
          const a = rec.agent
          if (a.status === 'error' || a.status === 'done') continue
          const s = await this.infra.agentStats(a.id).catch(() => null)
          if (!this.store.agents.has(a.id)) continue
          const container: Agent['container'] = s
            ? { name: a.container.name, cpuPct: Math.round(s.cpuPct * 10) / 10, memMb: Math.round(s.memMb), memLimitMb: Math.round(s.memLimitMb) || a.container.memLimitMb, health: s.running ? (this.store.connected.has(a.id) || a.status === 'booting' ? 'ok' : 'degraded') : 'down' }
            : { ...a.container, cpuPct: 0, memMb: 0, health: 'down' }
          if (s?.running) running++
          const uptimeSec = this.store.toAgent(rec).uptimeSec
          this.store.patchAgent(a.id, { container, uptimeSec })
        }
      }
      this.store.runningContainers = running
      this.store.broadcastResources()
    } catch (e) {
      this.log.warn(`stats tick failed: ${(e as Error).message}`)
    } finally {
      this.busy = false
    }
  }
}
