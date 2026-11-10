// Boot reconciliation with Docker, and the 5 s stats poller.

import type { Agent } from '@colony/shared'
import type { AgentManager } from './agents'
import type { InfraDriver } from './infra/types'
import type { Store } from './store'

type Log = { info: (m: string) => void; warn: (m: string) => void }

/** Mark agents whose container is gone as error; adopt running ones (await their runner). */
export async function reconcile(store: Store, infra: InfraDriver, agents: AgentManager, log: Log) {
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
  const byAgent = new Map(containers.filter((c) => c.kind === 'agent' && c.agentId).map((c) => [c.agentId!, c]))
  store.runningContainers = containers.filter((c) => c.kind === 'agent' && c.running).length

  for (const rec of store.agents.values()) {
    const id = rec.agent.id
    const c = byAgent.get(id)
    if (c?.running) {
      store.patchAgent(id, { container: { ...rec.agent.container, name: c.name, health: 'ok' } })
      agents.expectReconnect(id)
      log.info(`adopted running agent ${id}`)
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
      this.store.sampleHost()
      this.store.dockerUp = await this.infra.ping().catch(() => false)
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
