// Test helpers: an in-process control plane (ws server), a throwaway git origin, and the
// runner launched as a real child process (`node --import tsx src/main.ts`).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RunnerCommand } from '@colony/shared'

const here = dirname(fileURLToPath(import.meta.url))
export const PKG_DIR = join(here, '..', '..')
export const FAKE_CLAUDE = join(here, 'fake-claude.mjs')
export const FIXTURE = join(PKG_DIR, '..', 'shared', 'src', '__fixtures__', 'headless-run.jsonl')

export type Msg = Record<string, any>

export interface ControlPlane {
  url: string
  messages: Msg[]
  authHeaders: (string | undefined)[]
  connections: number
  send(cmd: RunnerCommand): void
  waitFor(pred: (m: Msg) => boolean, timeoutMs?: number, label?: string): Promise<Msg>
  /** Messages received after index `from` matching pred. */
  since(from: number, pred?: (m: Msg) => boolean): Msg[]
  dropClients(): void
  close(): Promise<void>
}

export async function startControlPlane(): Promise<ControlPlane> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as AddressInfo).port
  const messages: Msg[] = []
  const authHeaders: (string | undefined)[] = []
  const waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = []
  let socket: WebSocket | undefined
  let connections = 0

  wss.on('connection', (ws, req) => {
    connections++
    authHeaders.push(req.headers.authorization)
    socket = ws
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as Msg
      messages.push(m)
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m) }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}/api/runner`,
    messages,
    authHeaders,
    get connections() { return connections },
    send(cmd) {
      if (!socket) throw new Error('runner not connected')
      socket.send(JSON.stringify(cmd))
    },
    waitFor(pred, timeoutMs = 10_000, label = 'message') {
      const found = messages.find(pred)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: (m: Msg) => { clearTimeout(t); resolve(m) } }
        const t = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1)
          reject(new Error(`timed out waiting for ${label}; got:\n${messages.map((m) => JSON.stringify(m).slice(0, 200)).join('\n')}`))
        }, timeoutMs)
        waiters.push(w)
      })
    },
    since(from, pred = () => true) { return messages.slice(from).filter(pred) },
    dropClients() { for (const c of wss.clients) c.terminate() },
    close() {
      for (const c of wss.clients) c.terminate()
      return new Promise((r) => wss.close(() => r()))
    },
  }
}

export interface Sandbox {
  root: string
  bare: string
  workspace: string
  fakeLog: string
  /** Parsed FAKE_CLAUDE_LOG entries. */
  fakeEvents(): Msg[]
  starts(): string[][]
  cleanup(): void
}

const gitId = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main']

export function makeSandbox(opts: { withMain?: boolean } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'colony-runner-test-'))
  const bare = join(root, 'origin.git')
  const workspace = join(root, 'workspace')
  execFileSync('git', [...gitId, 'init', '--bare', bare], { stdio: 'ignore' })
  if (opts.withMain !== false) {
    const seed = join(root, 'seed')
    mkdirSync(seed)
    execFileSync('git', [...gitId, 'init'], { cwd: seed, stdio: 'ignore' })
    writeFileSync(join(seed, 'README.md'), '# test\n')
    execFileSync('git', [...gitId, 'add', '.'], { cwd: seed, stdio: 'ignore' })
    execFileSync('git', [...gitId, 'commit', '-m', 'init'], { cwd: seed, stdio: 'ignore' })
    execFileSync('git', [...gitId, 'push', bare, 'HEAD:refs/heads/main'], { cwd: seed, stdio: 'ignore' })
  }
  const fakeLog = join(root, 'fake.log')
  const fakeEvents = () => existsSync(fakeLog)
    ? readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Msg)
    : []
  return {
    root, bare, workspace, fakeLog, fakeEvents,
    starts: () => fakeEvents().filter((e) => e.kind === 'start').map((e) => e.args as string[]),
    cleanup: () => { try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* Windows file locks */ } },
  }
}

export interface RunnerHandle {
  child: ChildProcess
  stderr: () => string
  exited: Promise<number | null>
  kill(): Promise<void>
}

export function baseEnv(cp: ControlPlane, sb: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('COLONY_') && !k.startsWith('FAKE_CLAUDE')) env[k] = v
  return {
    ...env,
    COLONY_AGENT_ID: 'agent-1',
    COLONY_PROJECT_ID: 'proj-1',
    COLONY_CONTROL_URL: cp.url,
    COLONY_AGENT_TOKEN: 'test-agent-token',
    COLONY_GIT_URL: sb.bare,
    COLONY_BRANCH: 'agent/test-01',
    COLONY_MODEL: 'claude-haiku-5-5',
    COLONY_SYSTEM_PROMPT_B64: Buffer.from('You are a test agent.').toString('base64'),
    CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token',
    COLONY_WORKSPACE: sb.workspace,
    COLONY_CLAUDE_BIN: FAKE_CLAUDE,
    COLONY_RESTART_BASE_MS: '50',
    FAKE_CLAUDE_LOG: sb.fakeLog,
    FAKE_CLAUDE_FIXTURE: FIXTURE,
    ...extra,
  }
}

export function startRunner(env: Record<string, string>): RunnerHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', join(PKG_DIR, 'src', 'main.ts')], {
    cwd: PKG_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let err = ''
  child.stderr!.on('data', (d) => { err += d })
  child.stdout!.on('data', (d) => { err += d })
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
  return {
    child,
    stderr: () => err,
    exited,
    async kill() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    },
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Statuses sent, in order. */
export const statuses = (msgs: Msg[]) => msgs.filter((m) => m.type === 'status').map((m) => m.status as string)
