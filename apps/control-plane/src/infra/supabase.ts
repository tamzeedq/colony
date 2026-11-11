// Dev Supabase stacks, one per project (docs/phase4.md). The Supabase CLI runs on the host
// (pinned in package.json); Docker is used only to attach kong/db to the project network,
// read container state and query the migrations table.
//
// Safety: every CLI call names this project's workdir and project id. `stop --all` is never
// used, so other stacks on the machine (the commander's own projects) are never touched.
// Raw CLI output can contain keys: it is never logged, and errors are redacted.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type Dockerode from 'dockerode'
import { execIn } from './exec'
import { assertSlug, names } from './validate'

export interface SupabaseStack {
  apiPort: number
  dbPort: number
  studioPort?: number
  anonKey: string
  serviceRoleKey: string
}

export interface SupabaseMigrationRow { version: string; name: string }

export type SupabaseState = 'running' | 'stopped' | 'none'

export interface SupabaseDriver {
  /** Write the workdir (if needed) and start the stack on the slot's ports, attach kong and db
   *  to colony-proj-<slug> (aliases supabase-kong / supabase-db), wait for health. */
  start(slug: string, opts: { slot: number; studio: boolean; timeoutMs?: number }): Promise<SupabaseStack>
  /** Stop the stack. With wipe, its data volumes are deleted too. */
  stop(slug: string, opts?: { wipe?: boolean }): Promise<void>
  /** From the db container: running, stopped (exists but not running), none (no container). */
  state(slug: string): Promise<SupabaseState>
  /** Keys and ports of a running stack, or null. */
  info(slug: string): Promise<SupabaseStack | null>
  migrations(slug: string): Promise<SupabaseMigrationRow[]>
  genTypes(slug: string): Promise<string>
  /** Stop (wiping data when purge) and delete the workdir. */
  remove(slug: string, opts?: { purge?: boolean }): Promise<void>
  /** Are all ports of this slot free on the host? */
  slotFree(slot: number): Promise<boolean>
}

export const SUPABASE_PORT_OFFSETS = { shadow: 0, api: 1, db: 2, studio: 3, smtp: 4, analytics: 7, inspector: 8, pooler: 9 } as const

export function slotPorts(basePort: number, slot: number) {
  const base = basePort + 10 * slot
  const o = SUPABASE_PORT_OFFSETS
  return {
    shadow: base + o.shadow, api: base + o.api, db: base + o.db, studio: base + o.studio,
    smtp: base + o.smtp, analytics: base + o.analytics, inspector: base + o.inspector, pooler: base + o.pooler,
  }
}

/** Services left out of `supabase start`. Studio mode also runs studio + postgres-meta. */
export function excludedServices(studio: boolean): string[] {
  const all = ['studio', 'realtime', 'storage-api', 'imgproxy', 'postgres-meta', 'mailpit', 'logflare', 'vector', 'edge-runtime', 'supavisor']
  return studio ? all.filter((s) => s !== 'studio' && s !== 'postgres-meta') : all
}

export const supabaseProjectId = (slug: string) => `colony-${slug}`
export const supabaseContainer = (svc: 'db' | 'kong' | 'studio', slug: string) => `supabase_${svc}_${supabaseProjectId(slug)}`

/** Set `key = value` inside `[section]` of a TOML document, replacing an existing (or
 *  commented-out) line, or appending it to the section. Enough for config.toml. */
export function setTomlKey(toml: string, section: string, key: string, value: string | number | boolean): string {
  const lines = toml.split('\n')
  const v = typeof value === 'string' ? JSON.stringify(value) : String(value)
  const header = `[${section}]`
  const start = lines.findIndex((l) => l.trim() === header)
  if (start === -1) {
    lines.push('', header, `${key} = ${v}`)
    return lines.join('\n')
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^\s*\[/.test(lines[i])) { end = i; break }
  const re = new RegExp(`^\\s*#?\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`)
  for (let i = start + 1; i < end; i++) {
    if (re.test(lines[i]) && !lines[i].trim().startsWith('#')) { lines[i] = `${key} = ${v}`; return lines.join('\n') }
  }
  lines.splice(start + 1, 0, `${key} = ${v}`)
  return lines.join('\n')
}

export function patchConfig(toml: string, slug: string, ports: ReturnType<typeof slotPorts>): string {
  let t = toml
  // project_id is a top-level key (before the first section).
  if (/^project_id\s*=.*$/m.test(t)) t = t.replace(/^project_id\s*=.*$/m, `project_id = ${JSON.stringify(supabaseProjectId(slug))}`)
  else t = `project_id = ${JSON.stringify(supabaseProjectId(slug))}\n${t}`
  t = setTomlKey(t, 'api', 'port', ports.api)
  t = setTomlKey(t, 'db', 'port', ports.db)
  t = setTomlKey(t, 'db', 'shadow_port', ports.shadow)
  t = setTomlKey(t, 'db.pooler', 'port', ports.pooler)
  t = setTomlKey(t, 'studio', 'port', ports.studio)
  t = setTomlKey(t, 'local_smtp', 'port', ports.smtp)
  t = setTomlKey(t, 'local_smtp', 'enabled', false)
  t = setTomlKey(t, 'analytics', 'port', ports.analytics)
  t = setTomlKey(t, 'analytics', 'enabled', false)
  t = setTomlKey(t, 'edge_runtime', 'inspector_port', ports.inspector)
  t = setTomlKey(t, 'edge_runtime', 'enabled', false)
  return t
}

/** Strip anything that looks like a key or JWT from CLI output before it reaches an alert. */
export function redact(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bsb_(publishable|secret)_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/((?:KEY|SECRET|TOKEN)\S*\s*[=:]\s*)\S+/gi, '$1[redacted]')
}

/** Parse `supabase status -o json` (or env) output into the stack fields. */
export function parseStatus(out: string): SupabaseStack | null {
  let vals: Record<string, string> = {}
  const trimmed = out.trim()
  const jsonStart = trimmed.indexOf('{')
  if (jsonStart >= 0) {
    try { vals = JSON.parse(trimmed.slice(jsonStart, trimmed.lastIndexOf('}') + 1)) } catch { vals = {} }
  }
  if (!Object.keys(vals).length) {
    for (const line of trimmed.split(/\r?\n/)) {
      const m = /^([A-Z_]+)=("?)(.*)\2$/.exec(line.trim())
      if (m) vals[m[1]] = m[3]
    }
  }
  const port = (u?: string) => { try { return u ? Number(new URL(u).port) || undefined : undefined } catch { return undefined } }
  const apiPort = port(vals.API_URL)
  const dbPort = port(vals.DB_URL)
  const anonKey = vals.ANON_KEY
  const serviceRoleKey = vals.SERVICE_ROLE_KEY
  if (!apiPort || !dbPort || !anonKey || !serviceRoleKey) return null
  return { apiPort, dbPort, anonKey, serviceRoleKey, ...(vals.STUDIO_URL ? { studioPort: port(vals.STUDIO_URL) } : {}) }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '127.0.0.1')
  })
}

export interface CliSupabaseOptions {
  docker: Dockerode
  /** Path to node_modules/supabase/dist/supabase.js (run with this Node). */
  cliPath: string
  /** <dataDir>/supabase */
  rootDir: string
  basePort: number
  log?: { warn(m: string): void }
}

export function createCliSupabaseDriver(o: CliSupabaseOptions): SupabaseDriver {
  const workdir = (slug: string) => join(o.rootDir, slug)

  const cli = (args: string[], timeoutMs = 120_000) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, [o.cliPath, ...args], {
      timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' },
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      resolve({ code, out: String(stdout), err: String(stderr) })
    })
  })

  const fail = (what: string, r: { out: string; err: string }) => {
    const tail = redact(`${r.err}\n${r.out}`).trim().split(/\r?\n/).slice(-6).join('\n')
    return new Error(`${what} failed${tail ? `: ${tail}` : ''}`)
  }

  const ensureWorkdir = async (slug: string, slot: number) => {
    const dir = workdir(slug)
    const cfg = join(dir, 'supabase', 'config.toml')
    if (!existsSync(cfg)) {
      mkdirSync(dir, { recursive: true })
      const r = await cli(['init', '--workdir', dir, '--yes'])
      if (r.code !== 0 || !existsSync(cfg)) throw fail('supabase init', r)
    }
    const before = readFileSync(cfg, 'utf8')
    const after = patchConfig(before, slug, slotPorts(o.basePort, slot))
    if (after !== before) writeFileSync(cfg, after)
    return dir
  }

  const containerState = async (name: string): Promise<SupabaseState> => {
    try {
      const i = await o.docker.getContainer(name).inspect()
      return i.State?.Running ? 'running' : 'stopped'
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return 'none'
      throw e
    }
  }

  const attach = async (slug: string) => {
    const net = o.docker.getNetwork(names.network(slug))
    for (const [svc, alias] of [['kong', 'supabase-kong'], ['db', 'supabase-db']] as const) {
      const container = supabaseContainer(svc, slug)
      try {
        await net.connect({ Container: container, EndpointConfig: { Aliases: [alias] } })
      } catch (e) {
        const msg = String((e as Error).message)
        // Already attached (403 "already exists" on Docker Desktop) is fine.
        if (!/already exists|is already connected/i.test(msg)) throw e
      }
    }
  }

  const waitHealthy = async (apiPort: number, anonKey: string, deadline: number) => {
    let last = ''
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${apiPort}/auth/v1/health`, { headers: { apikey: anonKey }, signal: AbortSignal.timeout(3000) })
        if (r.ok) return
        last = `HTTP ${r.status}`
      } catch (e) { last = (e as Error).message }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`Supabase did not become healthy (${last})`)
  }

  const info = async (slug: string): Promise<SupabaseStack | null> => {
    assertSlug(slug)
    const dir = workdir(slug)
    if (!existsSync(join(dir, 'supabase', 'config.toml'))) return null
    const r = await cli(['status', '--workdir', dir, '-o', 'json'], 60_000)
    if (r.code !== 0) return null
    return parseStatus(r.out)
  }

  const stop = async (slug: string, opts: { wipe?: boolean } = {}) => {
    assertSlug(slug)
    const dir = workdir(slug)
    const args = ['stop', '--project-id', supabaseProjectId(slug)]
    if (existsSync(join(dir, 'supabase', 'config.toml'))) args.push('--workdir', dir)
    if (opts.wipe) args.push('--no-backup')
    const r = await cli(args, 180_000)
    if (r.code !== 0) throw fail('supabase stop', r)
  }

  return {
    async start(slug, { slot, studio, timeoutMs = 15 * 60_000 }) {
      assertSlug(slug)
      const deadline = Date.now() + timeoutMs
      const dir = await ensureWorkdir(slug, slot)
      const r = await cli(['start', '--workdir', dir, '-x', excludedServices(studio).join(',')], timeoutMs)
      if (r.code !== 0) throw fail('supabase start', r)
      await attach(slug)
      const stack = await info(slug)
      if (!stack) throw new Error('supabase status returned no keys')
      await waitHealthy(stack.apiPort, stack.anonKey, deadline)
      return studio ? { ...stack, studioPort: stack.studioPort ?? slotPorts(o.basePort, slot).studio } : { ...stack, studioPort: undefined }
    },
    stop,
    async state(slug) {
      assertSlug(slug)
      return containerState(supabaseContainer('db', slug))
    },
    info,
    async migrations(slug) {
      assertSlug(slug)
      const sql = `select version, coalesce(name,'') from supabase_migrations.schema_migrations order by version`
      const r = await execIn(o.docker, supabaseContainer('db', slug), ['psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-F', '\t', '-c', sql], { user: 'postgres', timeoutMs: 20_000 })
      if (r.exitCode !== 0) {
        if (/does not exist/.test(r.stderr)) return []
        throw new Error(`could not read migrations: ${redact(r.stderr).trim().slice(0, 300)}`)
      }
      return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [version, name = ''] = l.split('\t')
        return { version, name }
      })
    },
    async genTypes(slug) {
      assertSlug(slug)
      const r = await cli(['gen', 'types', 'typescript', '--local', '--workdir', workdir(slug)], 5 * 60_000)
      if (r.code !== 0) throw fail('supabase gen types', r)
      return r.out
    },
    async remove(slug, opts = {}) {
      assertSlug(slug)
      if ((await containerState(supabaseContainer('db', slug))) !== 'none' || opts.purge) {
        try { await stop(slug, { wipe: !!opts.purge }) } catch (e) { o.log?.warn(`supabase stop for ${slug}: ${(e as Error).message}`) }
      }
      rmSync(workdir(slug), { recursive: true, force: true })
    },
    async slotFree(slot) {
      const p = slotPorts(o.basePort, slot)
      for (const port of [p.shadow, p.api, p.db, p.studio]) if (!(await portFree(port))) return false
      return true
    },
  }
}

/** Driver used when none is configured: reports no stacks and refuses to start one. */
export function unavailableSupabase(): SupabaseDriver {
  const no = async (): Promise<never> => { throw new Error('dev Supabase is not available in this control plane') }
  return {
    start: no, stop: async () => {}, state: async () => 'none', info: async () => null,
    migrations: no, genTypes: no, remove: async () => {}, slotFree: async () => true,
  }
}
