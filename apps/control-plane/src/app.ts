// Wires the control plane together. main.ts calls this with the Docker driver; tests call
// it with a stub InfraDriver and a temp DB.

import Fastify, { type FastifyInstance } from 'fastify'
import { registerAdminRoutes } from './admin'
import { AgentManager } from './agents'
import { AnalyticsService, registerAnalyticsRoutes } from './analytics'
import type { Config } from './config'
import { Db } from './db'
import { GithubService, registerGithubRoutes } from './github'
import { GuardService } from './guards'
import { registerRoutes } from './http'
import { KeepAwake, registerKeepAwakeRoutes, type KeepAwakeOptions } from './keepawake'
import { LoopDetector } from './loops'
import { registerMcp } from './mcp'
import { QuestService } from './quests'
import { SupabaseService } from './supabase'
import { CheckpointService } from './checkpoints'
import { TeamCheckService } from './teamcheck'
import { AccessService } from './access'
import { unavailableSupabase, type SupabaseDriver } from './infra/supabase'
import type { InfraDriver } from './infra/types'
import { MergeService, ProjectService } from './projects'
import { ProviderService, type FetchLike } from './providers'
import { reconcile, StatsPoller } from './reconcile'
import { redactEvent, SecretValues } from './redact'
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
  /** Keep-awake helper options (tests inject a spawner). With poll: false and no spawner, the
   *  helper is a no-op so tests never start a real process. */
  keepAwake?: KeepAwakeOptions
  /** Where the rotated admin token's pairing link is printed (default stdout). */
  print?: (line: string) => void
  /** Called after POST /api/admin/shutdown has closed the app. Default: process.exit(0). Tests inject a spy. */
  onShutdown?: () => void
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
  teamCheck: TeamCheckService
  access: AccessService
  analytics: AnalyticsService
  github: GithubService
  keepAwake: KeepAwake
  secrets: SecretValues
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
  // Every ActivityEvent is scrubbed of known secret values and secret-shaped strings (redact.ts).
  const secrets = new SecretValues(db, config)
  store.redactEvent = (ev) => redactEvent(ev, secrets.values())
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
  const access = new AccessService(store, infra, agents)
  agents.hooks.afterRemove = (a) => { loops.forget(a.id); quests.onAgentRemoved(a); access.onAgentRemoved(a.id) }
  agents.hooks.afterCrash = (a, reason) => {
    if (a.role !== 'orchestrator') quests.notifyOrchestrator(a.projectId, `${a.callsign} ${reason}. The commander has been alerted; reassign its quest if this blocks progress.`)
  }
  const github = new GithubService(store, config, infra, opts.fetch)
  const noSpawn = opts.poll === false && !opts.keepAwake?.spawner
  const keepAwake = new KeepAwake(store, db, {
    log, ...opts.keepAwake,
    ...(noSpawn ? { spawner: () => ({ kill: () => {}, onExit: () => {} }) } : {}),
  })
  store.keepAwake = () => keepAwake.state()
  const terminals = new TerminalHub(config, store, infra, log)
  const stats = new StatsPoller(store, infra, config.statsIntervalMs, log, config.agentCpus)
  const teamCheck = new TeamCheckService(store, agents, infra)
  stats.onTick = () => { guards.checkSessionRollover(); void teamCheck.tick() }
  stats.onDockerBack = async () => {
    await reconcile(store, infra, agents, log, { autoResume: config.autoResume })
    await supabase.reconcile()
  }

  const fastify = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 })
  let closeApp: () => Promise<void> = async () => {}
  registerRoutes(fastify, {
    config, store, agents, projects, merges, guards, providers, quests, supabase, checkpoints, teamCheck, access,
    close: () => closeApp(), onShutdown: opts.onShutdown,
  })
  const analytics = new AnalyticsService(db, store)
  registerAnalyticsRoutes(fastify, analytics)
  registerGithubRoutes(fastify, { github, store })
  registerAdminRoutes(fastify, { config, print: opts.print })
  registerKeepAwakeRoutes(fastify, keepAwake)
  registerMcp(fastify, { store, agents, quests, merges, infra, supabase })
  const sockets = attachWebSockets(fastify.server, { config, store, agents, terminals, log })

  const result: ColonyApp = {
    fastify, db, store, agents, guards, projects, merges, providers, terminals, stats, quests, loops, supabase, checkpoints, analytics, github, teamCheck, keepAwake, secrets, access,
    async start(port = config.port, host = config.bind) {
      await reconcile(store, infra, agents, log, { autoResume: config.autoResume })
      await access.cleanupLeftovers()
      await supabase.reconcile()
      guards.checkSessionRollover()
      await fastify.listen({ port, host })
      if (opts.poll !== false) { stats.start(); loops.start(); supabase.startTimer(); keepAwake.start() }
      const addr = fastify.server.address()
      return typeof addr === 'object' && addr ? addr.port : port
    },
    async close() {
      stats.stop()
      loops.stop()
      supabase.stopTimer()
      keepAwake.stop()
      agents.closeAll()
      await terminals.close()
      sockets.close()
      await fastify.close()
      store.dispose()
      db.close()
    },
  }
  closeApp = () => result.close()
  return result
}
