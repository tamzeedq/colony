// Dev Supabase per project (docs/phase4.md): provisioning, start/stop with activity, wipe,
// agent env and the "Dev backend" prompt section. The driver does the Docker/CLI work.

import type { Agent, SupabaseDetails, SupabaseInfo } from '@colony/shared'
import type { BackendProvider } from './agents'
import type { Config } from './config'
import type { Db } from './db'
import { badRequest, conflict, notFound } from './errors'
import type { SupabaseDriver, SupabaseStack } from './infra/supabase'
import type { QuestService } from './quests'
import type { ProjectRecord, Store } from './store'

type Keys = { anonKey: string; serviceRoleKey: string }
type Log = { info(m: string): void; warn(m: string): void }

export const IN_NETWORK = {
  url: 'http://supabase-kong:8000',
  databaseUrl: 'postgresql://postgres:postgres@supabase-db:5432/postgres',
}

const IDLE_STATUSES = new Set(['error', 'done'])

export class SupabaseService implements BackendProvider {
  /** In-flight start/stop/reset per project. */
  private ops = new Map<string, Promise<void>>()
  private idleSince = new Map<string, number>()
  private timer?: NodeJS.Timeout
  quests?: QuestService

  constructor(
    private store: Store,
    private db: Db,
    private driver: SupabaseDriver,
    private config: Pick<Config, 'supabaseBasePort' | 'supabaseIdleMs' | 'supabaseStartTimeoutMs'>,
    private log: Log,
    private now: () => number = Date.now,
  ) {}

  // ── reads ───────────────────────────────────────────────────────────────────

  private rec(projectId: string): ProjectRecord {
    const r = this.store.projects.get(projectId)
    if (!r) throw notFound('project')
    return r
  }

  info(projectId: string): SupabaseInfo { return this.rec(projectId).project.supabase }

  private keys(projectId: string): Keys | undefined {
    return this.db.kvGet<Keys>(`supabase_keys:${projectId}`) ?? undefined
  }

  env(projectId: string): Record<string, string> | undefined {
    const r = this.store.projects.get(projectId)
    if (!r || r.project.supabase.status === 'none') return undefined
    const k = this.keys(projectId)
    return {
      SUPABASE_URL: IN_NETWORK.url,
      DATABASE_URL: IN_NETWORK.databaseUrl,
      ...(k ? { SUPABASE_ANON_KEY: k.anonKey, SUPABASE_SERVICE_ROLE_KEY: k.serviceRoleKey } : {}),
    }
  }

  prompt(projectId: string): string | undefined {
    const r = this.store.projects.get(projectId)
    if (!r || r.project.supabase.status === 'none') return undefined
    return [
      '## Dev backend',
      '',
      'This base has its own local Supabase stack (Postgres, Auth, REST) for development. It is reachable from your container only:',
      '',
      `- \`SUPABASE_URL\` = ${IN_NETWORK.url} (REST at /rest/v1, Auth at /auth/v1)`,
      '- `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are in your environment.',
      `- \`DATABASE_URL\` = ${IN_NETWORK.databaseUrl} (\`psql "$DATABASE_URL"\` works).`,
      '',
      'Schema changes go in migrations, committed to the repo: `supabase migration new <name>` creates `supabase/migrations/<timestamp>_<name>.sql` (run `supabase init` once if the repo has no `supabase/` folder). Apply them with `supabase db push --db-url "$DATABASE_URL"`. Use `list_migrations` to see what is applied and `gen_types` for TypeScript types. If the stack is not running, `get_backend` says so; ask the orchestrator rather than starting it yourself.',
      '',
      'This database is disposable dev data and can be wiped by the commander. Never point it at, or copy data from, a production project.',
    ].join('\n')
  }

  /** Values for the get_backend MCP tool. */
  backendFor(projectId: string) {
    const s = this.info(projectId)
    return { status: s.status, ...(s.error ? { error: s.error } : {}), env: this.env(projectId) ?? null, hostApiUrl: s.url ?? null, studioUrl: s.studioUrl ?? null }
  }

  async details(projectId: string): Promise<SupabaseDetails> {
    const r = this.rec(projectId)
    const s = r.project.supabase
    let migrations: SupabaseDetails['migrations'] = []
    if (s.status === 'running') {
      try {
        migrations = await this.driver.migrations(r.slug)
        const latest = migrations.at(-1)?.version
        if (latest !== s.migration) this.patch(projectId, { migration: latest })
      } catch (e) { this.log.warn(`supabase migrations for ${r.slug}: ${(e as Error).message}`) }
    }
    return { ...this.info(projectId), migrations }
  }

  async migrations(projectId: string) {
    const r = this.rec(projectId)
    if (r.project.supabase.status !== 'running') throw conflict(`the dev Supabase is ${r.project.supabase.status}, not running`)
    return this.driver.migrations(r.slug)
  }

  async genTypes(projectId: string) {
    const r = this.rec(projectId)
    if (r.project.supabase.status !== 'running') throw conflict(`the dev Supabase is ${r.project.supabase.status}, not running`)
    return this.driver.genTypes(r.slug)
  }

  /** Resolves when the project's in-flight operation (if any) has finished. */
  settled(projectId: string): Promise<void> { return this.ops.get(projectId) ?? Promise.resolve() }

  // ── state helpers ───────────────────────────────────────────────────────────

  private patch(projectId: string, partial: Partial<SupabaseInfo>, replace = false) {
    const r = this.store.projects.get(projectId)
    if (!r) return
    const base = replace ? { slot: r.project.supabase.slot, studio: r.project.supabase.studio } : r.project.supabase
    const next: SupabaseInfo = { ...base, ...partial } as SupabaseInfo
    for (const k of Object.keys(next) as (keyof SupabaseInfo)[]) if (next[k] === undefined) delete next[k]
    r.project = { ...r.project, supabase: next }
    this.store.saveProject(r)
    this.store.broadcastSnapshot()
  }

  private running(projectId: string, stack: SupabaseStack) {
    this.db.kvSet(`supabase_keys:${projectId}`, { anonKey: stack.anonKey, serviceRoleKey: stack.serviceRoleKey })
    const cur = this.info(projectId)
    this.patch(projectId, {
      status: 'running',
      url: `http://127.0.0.1:${stack.apiPort}`,
      dbUrl: `postgresql://postgres:postgres@127.0.0.1:${stack.dbPort}/postgres`,
      studioUrl: stack.studioPort ? `http://127.0.0.1:${stack.studioPort}` : undefined,
      migration: cur.migration,
    }, true)
  }

  private async allocSlot(projectId: string): Promise<number> {
    const own = this.info(projectId).slot
    const taken = new Set<number>()
    for (const r of this.store.projects.values()) {
      if (r.project.id !== projectId && r.project.supabase.slot !== undefined) taken.add(r.project.supabase.slot)
    }
    if (own !== undefined && !taken.has(own)) return own
    for (let n = 0; n < 100; n++) {
      if (taken.has(n)) continue
      if (await this.driver.slotFree(n)) return n
    }
    throw conflict('no free port slot for a dev Supabase (55300–56299 all in use)')
  }

  private run(projectId: string, what: string, fn: () => Promise<void>) {
    if (this.ops.has(projectId)) throw conflict('a dev Supabase operation is already in progress for this base')
    const p = (async () => {
      try { await fn() } catch (e) {
        const msg = (e as Error).message
        this.log.warn(`supabase ${what} for ${projectId}: ${msg}`)
        this.patch(projectId, { status: 'error', error: msg.slice(0, 600) })
        const r = this.store.projects.get(projectId)
        if (r) {
          this.store.raiseAlert({
            id: `al-supabase-${projectId}`, kind: 'crash', severity: 'needs_you', projectId,
            title: `Dev Supabase failed to ${what} on ${r.project.name}`, detail: msg.slice(0, 600),
          })
        }
      } finally { this.ops.delete(projectId) }
    })()
    this.ops.set(projectId, p)
  }

  private doStart(projectId: string, what: 'start' | 'reset') {
    this.run(projectId, what, async () => {
      const r = this.rec(projectId)
      const studio = !!r.project.supabase.studio
      if (what === 'reset') await this.driver.stop(r.slug, { wipe: true })
      const slot = await this.allocSlot(projectId)
      this.patch(projectId, { status: 'provisioning', slot, error: undefined, ...(what === 'reset' ? { migration: undefined } : {}) })
      const stack = await this.driver.start(r.slug, { slot, studio, timeoutMs: this.config.supabaseStartTimeoutMs })
      this.running(projectId, stack)
      this.idleSince.delete(projectId)
      const resolved = this.store.alerts.get(`al-supabase-${projectId}`)
      if (resolved && !resolved.resolvedAt) this.store.resolveAlert(resolved.id)
      this.quests?.notifyOrchestrator(projectId, `The dev Supabase for this base is running${what === 'reset' ? ' again with an empty database (the commander wiped it)' : ''}. Agents reach it at ${IN_NETWORK.url} and ${IN_NETWORK.databaseUrl}; workers started before now can call get_backend for the keys, or be restarted to get them as env vars.`)
    })
  }

  // ── commands ────────────────────────────────────────────────────────────────

  /** Provision (first time) or start a stopped stack. Returns at once; work runs in the background. */
  start(projectId: string): SupabaseInfo {
    const s = this.info(projectId)
    if (s.status === 'running') return s
    if (this.ops.has(projectId)) throw conflict('a dev Supabase operation is already in progress for this base')
    this.patch(projectId, { status: 'provisioning', error: undefined })
    this.doStart(projectId, 'start')
    return this.info(projectId)
  }

  stop(projectId: string): SupabaseInfo {
    const r = this.rec(projectId)
    const s = r.project.supabase
    if (s.status === 'none') throw conflict('this base has no dev Supabase')
    if (s.status === 'stopped') return s
    this.run(projectId, 'stop', async () => {
      await this.driver.stop(r.slug)
      this.patch(projectId, { status: 'stopped' }, true)
    })
    return this.info(projectId)
  }

  reset(projectId: string, confirm: boolean): SupabaseInfo {
    if (!confirm) throw badRequest('reset deletes all data in this base\'s dev database; send {"confirm": true}')
    const s = this.info(projectId)
    if (s.status === 'none') throw conflict('this base has no dev Supabase')
    if (this.ops.has(projectId)) throw conflict('a dev Supabase operation is already in progress for this base')
    this.patch(projectId, { status: 'provisioning', error: undefined })
    this.doStart(projectId, 'reset')
    return this.info(projectId)
  }

  /** Turn Studio on/off. A running stack restarts (data kept) to apply it. */
  setStudio(projectId: string, studio: boolean): SupabaseInfo {
    const r = this.rec(projectId)
    const s = r.project.supabase
    if (!!s.studio === studio) return s
    if (this.ops.has(projectId)) throw conflict('a dev Supabase operation is already in progress for this base')
    this.patch(projectId, { studio })
    if (s.status === 'running') {
      this.run(projectId, 'restart', async () => {
        this.patch(projectId, { status: 'provisioning' })
        await this.driver.stop(r.slug)
        const slot = await this.allocSlot(projectId)
        const stack = await this.driver.start(r.slug, { slot, studio, timeoutMs: this.config.supabaseStartTimeoutMs })
        this.running(projectId, stack)
      })
    }
    return this.info(projectId)
  }

  /** New project with the "Provision dev Supabase" toggle on. */
  provisionNew(projectId: string, opts: { studio?: boolean } = {}) {
    if (opts.studio) this.patch(projectId, { studio: true })
    return this.start(projectId)
  }

  /** Spawning an agent wakes a stopped stack. */
  onAgentSpawn(agent: Agent) {
    this.idleSince.delete(agent.projectId)
    const s = this.store.projects.get(agent.projectId)?.project.supabase
    if (!s || this.ops.has(agent.projectId)) return
    if (s.status === 'stopped') {
      try { this.start(agent.projectId) } catch (e) { this.log.warn(`supabase auto-start: ${(e as Error).message}`) }
    }
  }

  /** Before the project's network is removed: the stack must be gone (it is attached to it). */
  async removeProject(rec: ProjectRecord, opts: { purge?: boolean } = {}) {
    await this.settled(rec.project.id).catch(() => {})
    if (rec.project.supabase.status !== 'none' || opts.purge) await this.driver.remove(rec.slug, opts)
    this.db.kvSet(`supabase_keys:${rec.project.id}`, null)
    this.idleSince.delete(rec.project.id)
  }

  // ── reconcile and idle stop ─────────────────────────────────────────────────

  async reconcile() {
    for (const r of this.store.projects.values()) {
      const s = r.project.supabase
      if (s.status === 'none') continue
      try {
        const state = await this.driver.state(r.slug)
        if (state === 'running') {
          const stack = await this.driver.info(r.slug)
          if (stack) { this.running(r.project.id, stack); continue }
        }
        if (s.status !== 'stopped' && s.status !== 'error') this.patch(r.project.id, { status: 'stopped' }, true)
      } catch (e) {
        this.log.warn(`supabase reconcile for ${r.slug}: ${(e as Error).message}`)
      }
    }
  }

  /** Stop stacks of bases that have had no live agents for supabaseIdleMs. */
  async tick() {
    const idleMs = this.config.supabaseIdleMs
    if (!idleMs) return
    const t = this.now()
    for (const r of this.store.projects.values()) {
      const id = r.project.id
      if (r.project.supabase.status !== 'running' || this.ops.has(id)) { this.idleSince.delete(id); continue }
      const live = this.store.projectAgents(id).some((a) => !IDLE_STATUSES.has(a.agent.status))
      if (live) { this.idleSince.delete(id); continue }
      const since = this.idleSince.get(id)
      if (since === undefined) { this.idleSince.set(id, t); continue }
      if (t - since >= idleMs) {
        this.idleSince.delete(id)
        this.log.info(`stopping idle dev Supabase for ${r.slug}`)
        try { this.stop(id) } catch (e) { this.log.warn(`supabase idle stop: ${(e as Error).message}`) }
      }
    }
  }

  startTimer(everyMs = 60_000) {
    this.stopTimer()
    this.timer = setInterval(() => { void this.tick() }, everyMs)
    this.timer.unref?.()
  }
  stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = undefined }
}
