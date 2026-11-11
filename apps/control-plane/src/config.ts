// Control-plane configuration from the environment (and the repo's .env for the
// subscription token). The OAuth token is kept on the config object only: it is never
// logged, never sent to the UI and never written to the DB.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Config {
  repoRoot: string
  port: number
  bind: string
  dataDir: string
  dbPath: string
  rolesDir: string
  agentImage: string
  publicRunnerUrl: string
  /** Colony MCP endpoint as agent containers reach it (docs/phase3.md). */
  publicMcpUrl: string
  gitUrl: string
  maxContainers: number
  /** Live agents per project, orchestrator included (default 5). */
  maxAgentsPerProject: number
  agentMemoryMb: number
  agentCpus: number
  defaultBudgetCapUsd: number
  defaultProjectDailyCapUsd: number
  dailyCapUsd: number
  eventsPerAgent: number
  runnerGraceMs: number
  statsIntervalMs: number
  /** Ops Deck origin for the pairing link (COLONY_UI_URL). */
  uiUrl: string
  /** Terminal sessions close after this long without input or output (default 30 min). */
  terminalIdleMs: number
  /** Concurrent terminal sessions per agent (default 3). */
  maxTerminalsPerAgent: number
  /** Restart agents whose containers stopped while Colony was down (COLONY_AUTO_RESUME, default on). */
  autoResume: boolean
  /** node_modules/supabase/dist/supabase.js, run with this Node (docs/phase4.md). */
  supabaseCli: string
  /** First host port of the dev Supabase slots (slot n uses base + 10n … +9). */
  supabaseBasePort: number
  /** Stop a base's stack after this long without live agents (0 = never). */
  supabaseIdleMs: number
  supabaseStartTimeoutMs: number
  /** Optional shared secret for the REST API and UI stream (see report: agents can reach the host port). */
  adminToken?: string
  /** CLAUDE_CODE_OAUTH_TOKEN. Secret: never log or serialise. */
  oauthToken?: string
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Minimal .env parser: KEY=value lines, optional quotes, # comments. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]] = v
  }
  return out
}

function readDotEnv(repoRoot: string): Record<string, string> {
  const p = join(repoRoot, '.env')
  if (!existsSync(p)) return {}
  try { return parseDotEnv(readFileSync(p, 'utf8')) } catch { return {} }
}

const num = (v: string | undefined, d: number) => {
  const n = v === undefined || v === '' ? NaN : Number(v)
  return Number.isFinite(n) ? n : d
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const repoRoot = overrides.repoRoot ?? REPO_ROOT
  const dotenv = readDotEnv(repoRoot)
  const get = (k: string) => env[k] ?? dotenv[k]
  const port = num(get('COLONY_PORT'), 7700)
  const dataDir = resolve(get('COLONY_DATA_DIR') || join(repoRoot, '.colony'))
  const cfg: Config = {
    repoRoot,
    port,
    bind: get('COLONY_BIND') || '0.0.0.0',
    dataDir,
    dbPath: join(dataDir, 'colony.db'),
    rolesDir: resolve(get('COLONY_ROLES_DIR') || join(repoRoot, 'roles')),
    agentImage: get('COLONY_AGENT_IMAGE') || 'colony-agent:dev',
    publicRunnerUrl: get('COLONY_PUBLIC_RUNNER_URL') || `ws://host.docker.internal:${port}/api/runner`,
    publicMcpUrl: get('COLONY_PUBLIC_MCP_URL') || `http://host.docker.internal:${port}/mcp`,
    gitUrl: 'git://git/repo.git',
    maxContainers: num(get('COLONY_MAX_CONTAINERS'), 12),
    maxAgentsPerProject: num(get('COLONY_MAX_AGENTS_PER_PROJECT'), 5),
    agentMemoryMb: num(get('COLONY_AGENT_MEMORY_MB'), 2048),
    agentCpus: num(get('COLONY_AGENT_CPUS'), 2),
    defaultBudgetCapUsd: num(get('COLONY_AGENT_BUDGET_USD'), 10),
    defaultProjectDailyCapUsd: num(get('COLONY_PROJECT_DAILY_CAP_USD'), 20),
    dailyCapUsd: num(get('COLONY_DAILY_CAP_USD'), 60),
    eventsPerAgent: num(get('COLONY_EVENTS_PER_AGENT'), 2000),
    runnerGraceMs: num(get('COLONY_RUNNER_GRACE_MS'), 30_000),
    statsIntervalMs: num(get('COLONY_STATS_INTERVAL_MS'), 5_000),
    uiUrl: (get('COLONY_UI_URL') || 'http://localhost:5173').replace(/\/+$/, ''),
    terminalIdleMs: num(get('COLONY_TERMINAL_IDLE_MS'), 30 * 60_000),
    maxTerminalsPerAgent: num(get('COLONY_MAX_TERMINALS_PER_AGENT'), 3),
    autoResume: get('COLONY_AUTO_RESUME') !== '0',
    supabaseCli: resolve(get('COLONY_SUPABASE_CLI') || join(repoRoot, 'node_modules', 'supabase', 'dist', 'supabase.js')),
    supabaseBasePort: num(get('COLONY_SUPABASE_BASE_PORT'), 55300),
    supabaseIdleMs: num(get('COLONY_SUPABASE_IDLE_MS'), 30 * 60_000),
    supabaseStartTimeoutMs: num(get('COLONY_SUPABASE_START_TIMEOUT_MS'), 15 * 60_000),
    adminToken: get('COLONY_ADMIN_TOKEN') || undefined,
    oauthToken: get('CLAUDE_CODE_OAUTH_TOKEN') || undefined,
    ...overrides,
  }
  // Keep the secret out of accidental JSON.stringify / util.inspect of the config.
  for (const k of ['oauthToken', 'adminToken'] as const) {
    const v = cfg[k]
    Object.defineProperty(cfg, k, { value: v, enumerable: false, writable: true })
  }
  return cfg
}
