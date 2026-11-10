// Runner configuration, read once from the container environment (docs/phase1.md
// "Agent container environment"). Everything is validated up front so a misconfigured
// container fails immediately with a readable list of problems instead of half-starting.

export interface RunnerConfig {
  agentId: string
  projectId: string
  controlUrl: string
  agentToken: string
  gitUrl: string
  branch: string
  /** Value for `claude --model`. */
  model: string
  /** Decoded `COLONY_SYSTEM_PROMPT_B64`; passed via `--append-system-prompt` when non-empty. */
  systemPrompt: string
  /** Claude session to resume on first start (`--resume`). */
  sessionId?: string
  /** Decoded + JSON-validated `COLONY_MCP_CONFIG_B64` (written to a file for `--mcp-config`). */
  mcpConfigJson?: string
  /** Git working tree. `COLONY_WORKSPACE`, default `/workspace`. */
  workspace: string
  /** Claude Code binary. `COLONY_CLAUDE_BIN`, default `claude`. A `.js`/`.mjs`/`.cjs` path is run with node. */
  claudeBin: string
  /** Base delay for CLI crash restarts (`COLONY_RESTART_BASE_MS`, default 1000). Tuning/test knob. */
  restartBaseMs: number
  /** How long `shutdown` waits for the CLI to exit after closing stdin (`COLONY_SHUTDOWN_GRACE_MS`, default 30000). */
  shutdownGraceMs: number
  /** How long to wait for an interrupt `control_response` before falling back to SIGINT (`COLONY_INTERRUPT_TIMEOUT_MS`, default 5000). */
  interruptTimeoutMs: number
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid agent-runner environment:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

type Env = Record<string, string | undefined>

function decodeB64(value: string): string | undefined {
  const compact = value.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) return undefined
  return Buffer.from(compact, 'base64').toString('utf8')
}

function intEnv(env: Env, name: string, def: number, problems: string[]): number {
  const raw = env[name]?.trim()
  if (!raw) return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    problems.push(`${name} must be a non-negative integer (got "${raw}")`)
    return def
  }
  return n
}

/** Parse and validate the environment. Throws `ConfigError` listing every problem found. */
export function loadConfig(env: Env = process.env): RunnerConfig {
  const problems: string[] = []
  const required = (name: string): string => {
    const v = env[name]?.trim()
    if (!v) problems.push(`${name} is required`)
    return v ?? ''
  }

  const agentId = required('COLONY_AGENT_ID')
  const projectId = required('COLONY_PROJECT_ID')
  const controlUrl = required('COLONY_CONTROL_URL')
  const agentToken = required('COLONY_AGENT_TOKEN')
  const gitUrl = required('COLONY_GIT_URL')
  const branch = required('COLONY_BRANCH')
  const model = required('COLONY_MODEL')

  if (controlUrl) {
    try {
      const u = new URL(controlUrl)
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') problems.push(`COLONY_CONTROL_URL must be a ws:// or wss:// URL (got "${controlUrl}")`)
    } catch {
      problems.push(`COLONY_CONTROL_URL is not a valid URL (got "${controlUrl}")`)
    }
  }
  if (branch && (branch === 'main' || branch.startsWith('-') || /[\s~^:?*[\\]|\.\.|@\{/.test(branch))) {
    problems.push(`COLONY_BRANCH must be a valid non-main branch name (got "${branch}")`)
  }

  let systemPrompt = ''
  const promptB64 = env.COLONY_SYSTEM_PROMPT_B64
  if (promptB64 === undefined) {
    problems.push('COLONY_SYSTEM_PROMPT_B64 is required (base64 of the composed role prompt; may encode an empty string)')
  } else {
    const decoded = decodeB64(promptB64)
    if (decoded === undefined) problems.push('COLONY_SYSTEM_PROMPT_B64 is not valid base64')
    else systemPrompt = decoded
  }

  let mcpConfigJson: string | undefined
  const mcpB64 = env.COLONY_MCP_CONFIG_B64?.trim()
  if (mcpB64) {
    const decoded = decodeB64(mcpB64)
    if (decoded === undefined) problems.push('COLONY_MCP_CONFIG_B64 is not valid base64')
    else {
      try {
        JSON.parse(decoded)
        mcpConfigJson = decoded
      } catch {
        problems.push('COLONY_MCP_CONFIG_B64 does not decode to valid JSON')
      }
    }
  }

  if (!env.CLAUDE_CODE_OAUTH_TOKEN?.trim() && !env.ANTHROPIC_API_KEY?.trim()) {
    problems.push('CLAUDE_CODE_OAUTH_TOKEN is required (subscription token for Claude Code)')
  }

  const restartBaseMs = intEnv(env, 'COLONY_RESTART_BASE_MS', 1000, problems)
  const shutdownGraceMs = intEnv(env, 'COLONY_SHUTDOWN_GRACE_MS', 30_000, problems)
  const interruptTimeoutMs = intEnv(env, 'COLONY_INTERRUPT_TIMEOUT_MS', 5000, problems)

  if (problems.length) throw new ConfigError(problems)

  const sessionId = env.COLONY_SESSION_ID?.trim() || undefined
  return {
    agentId, projectId, controlUrl, agentToken, gitUrl, branch, model, systemPrompt,
    ...(sessionId ? { sessionId } : {}),
    ...(mcpConfigJson ? { mcpConfigJson } : {}),
    workspace: env.COLONY_WORKSPACE?.trim() || '/workspace',
    claudeBin: env.COLONY_CLAUDE_BIN?.trim() || 'claude',
    restartBaseMs, shutdownGraceMs, interruptTimeoutMs,
  }
}
