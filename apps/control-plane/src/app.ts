// Wires the control plane together. main.ts calls this with the Docker driver; tests call
// it with a stub InfraDriver and a temp DB.

import Fastify, { type FastifyInstance } from 'fastify'
import { AgentManager } from './agents'
import type { Config } from './config'
import { Db } from './db'
import { GuardService } from './guards'
import { registerRoutes } from './http'
import { LoopDetector } from './loops'
import { registerMcp } from './mcp'
import { QuestService } from './quests'
import type { InfraDriver } from './infra/types'
import { MergeService, ProjectService } from './projects'
import { ProviderService, type FetchLike } from './providers'
import { reconcile, StatsPoller } from './reconcile'
import { RoleLibrary } from './roles'
import { Store } from './store'
import { TerminalHub } from './terminal'
import { attachWebSockets } from './ws'

export interface AppOptions {
  config: Config
  infra: InfraDriver
  /** Fastify logger option; false in tests. */
  logger?: boolean | object
  /** Skip the background stats poller (tests drive tick() themselves). */
  poll?: boolean
  quiet?: boolean
  /** fetch used for provider connection tests (tests inject a fake). */
  fetch?: FetchLike
}

export interface ColonyApp {
  fastify: FastifyInstance
  db: Db
  store: Store
  agents: AgentManager
  guards: GuardService
  projects: ProjectService
  merges: MergeService
  providers: ProviderService
  terminals: TerminalHub
  stats: StatsPoller
  quests: QuestService
  loops: LoopDetector
  /** Reconcile with Docker and start listening. Returns the bound port. */
  start(port?: number, host?: string): Promise<number>
  /** Graceful shutdown. Agent containers keep running and reconnect to the next instance. */
  close(): Promise<void>
}

export async function createApp(opts: AppOptions): Promise<ColonyApp> {
  const { config, infra } = opts
  const noop = () => {}
  const log = opts.quiet
    ? { info: noop, warn: noop }
    : { info: (m: string) => console.log(`[colony] ${m}`), warn: (m: string) => console.warn(`[colony] ${m}`) }

  const db = new Db(config.dbPath)
  const store = new Store(db, config)
  const roles = new RoleLibrary(config.rolesDir, log.warn)
  const agents = new AgentManager(store, infra, config, roles, log)
  const guards = new GuardService(store, agents)
  const projects = new ProjectService(store, infra, agents, config)
  const merges = new MergeService(store, infra, agents)
  const providers = new ProviderService(store, config, opts.fetch)
  store.providerList = () => providers.list()
  const quests = new QuestService(store, infra, agents)
  merges.quests = quests
  const loops = new LoopDetector(store, quests)
  agents.hooks.afterEvent = (ev) => loops.onEvent(ev)
  agents.hooks.afterRemove = (a) => { loops.forget(a.id); quests.onAgentRemoved(a) }
  agents.hooks.afterCrash = (a, reason) => {
    if (a.role !== 'orchestrator') quests.notifyOrchestrator(a.projectId, `${a.callsign} ${reason}. The commander has been alerted; reassign its quest if this blocks progress.`)
  }
  const terminals = new TerminalHub(config, store, infra, log)
  const stats = new StatsPoller(store, infra, config.statsIntervalMs, log)

  const fastify = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 })
  registerRoutes(fastify, { config, store, agents, projects, merges, guards, providers, quests })
  registerMcp(fastify, { store, agents, quests, merges, infra })
  const sockets = attachWebSockets(fastify.server, { config, store, agents, terminals, log })

  return {
    fastify, db, store, agents, guards, projects, merges, providers, terminals, stats, quests, loops,
    async start(port = config.port, host = config.bind) {
      await reconcile(store, infra, agents, log)
      await fastify.listen({ port, host })
      if (opts.poll !== false) { stats.start(); loops.start() }
      const addr = fastify.server.address()
      return typeof addr === 'object' && addr ? addr.port : port
    },
    async close() {
      stats.stop()
      loops.stop()
      agents.closeAll()
      await terminals.close()
      sockets.close()
      await fastify.close()
      store.dispose()
      db.close()
    },
  }
}
