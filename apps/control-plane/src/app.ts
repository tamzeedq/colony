// Wires the control plane together. main.ts calls this with the Docker driver; tests call
// it with a stub InfraDriver and a temp DB.

import Fastify, { type FastifyInstance } from 'fastify'
import { AgentManager } from './agents'
import { AnalyticsService, registerAnalyticsRoutes } from './analytics'
import type { Config } from './config'
import { Db } from './db'
import { GithubService, registerGithubRoutes } from './github'
import { GuardService } from './guards'
import { registerRoutes } from './http'
import { LoopDetector } from './loops'
import { registerMcp } from './mcp'
import { QuestService } from './quests'
import { SupabaseService } from './supabase'
import { CheckpointService } from './checkpoints'
import { unavailableSupabase, type SupabaseDriver } from './infra/supabase'
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
  /** Dev Supabase driver (docs/phase4.md). Tests pass FakeSupabase; default is a no-op that
   *  refuses to start stacks. */
  supabase?: SupabaseDriver
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
  supabase: SupabaseService
  checkpoints: CheckpointService
  analytics: AnalyticsService
  github: GithubService
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
  const supabase = new SupabaseService(store, db, opts.supabase ?? unavailableSupabase(), config, log)
  supabase.quests = quests
  projects.supabase = supabase
  agents.backend = supabase
  agents.hooks.afterSpawn = (a) => supabase.onAgentSpawn(a)
  const checkpoints = new CheckpointService(store, db, infra, agents)
  quests.onCompleted = (q, rec, sha) => checkpoints.onQuestCompleted(q, rec, sha)
  agents.hooks.afterEvent = (ev) => loops.onEvent(ev)
  agents.hooks.afterRemove = (a) => { loops.forget(a.id); quests.onAgentRemoved(a) }
  agents.hooks.afterCrash = (a, reason) => {
    if (a.role !== 'orchestrator') quests.notifyOrchestrator(a.projectId, `${a.callsign} ${reason}. The commander has been alerted; reassign its quest if this blocks progress.`)
  }
  const github = new GithubService(store, config, infra, opts.fetch)
  const terminals = new TerminalHub(config, store, infra, log)
  const stats = new StatsPoller(store, infra, config.statsIntervalMs, log)
  stats.onDockerBack = async () => {
    await reconcile(store, infra, agents, log, { autoResume: config.autoResume })
    await supabase.reconcile()
  }

  const fastify = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 })
  registerRoutes(fastify, { config, store, agents, projects, merges, guards, providers, quests, supabase, checkpoints })
  const analytics = new AnalyticsService(db, store)
  registerAnalyticsRoutes(fastify, analytics)
  registerGithubRoutes(fastify, { github, store })
  registerMcp(fastify, { store, agents, quests, merges, infra, supabase })
  const sockets = attachWebSockets(fastify.server, { config, store, agents, terminals, log })

  return {
    fastify, db, store, agents, guards, projects, merges, providers, terminals, stats, quests, loops, supabase, checkpoints, analytics, github,
    async start(port = config.port, host = config.bind) {
      await reconcile(store, infra, agents, log, { autoResume: config.autoResume })
      await supabase.reconcile()
      await fastify.listen({ port, host })
      if (opts.poll !== false) { stats.start(); loops.start(); supabase.startTimer() }
      const addr = fastify.server.address()
      return typeof addr === 'object' && addr ? addr.port : port
    },
    async close() {
      stats.stop()
      loops.stop()
      supabase.stopTimer()
      agents.closeAll()
      await terminals.close()
      sockets.close()
      await fastify.close()
      store.dispose()
      db.close()
    },
  }
}
