// Keep-awake (feedback item 16): stop the machine from sleeping while agents work, so a long
// run is not frozen halfway. Only the *system* is kept awake; the display may turn off and the
// screen may lock as usual.
//
// A small helper process holds the request, per platform, with no admin rights and nothing
// permanent: the OS drops the request when the helper exits, and the helper exits when the
// control plane is gone (it watches our pid), so a crash or Ctrl+C never leaves the machine
// stuck awake.
//   Windows: PowerShell calling SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
//            via Add-Type P/Invoke, in a loop that ends when our pid is gone (no powercfg).
//   macOS:   caffeinate -i -w <pid>
//   Linux:   systemd-inhibit --what=sleep … sh -c 'while kill -0 <pid>; do sleep 20; done'

import { spawn } from 'node:child_process'
import { KEEP_AWAKE_MODES, type AgentStatus, type KeepAwakeMode, type KeepAwakeState } from '@colony/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from './db'
import { badRequest } from './errors'
import type { Store } from './store'

const KV = 'keep_awake'
/** Statuses that count as "working". */
const BUSY: ReadonlySet<AgentStatus> = new Set(['running', 'thinking', 'editing', 'booting'])
export const RELEASE_DELAY_MS = 3 * 60_000

export interface HeldProcess {
  kill(): void
  /** Called once when the helper exits (or fails to start, with an error). */
  onExit(cb: (code: number | null, error?: Error) => void): void
}
export type Spawner = (cmd: string, args: string[]) => HeldProcess

export interface HelperCommand { cmd: string; args: string[] }

/** The helper for this platform, or undefined when none is supported. */
export function helperCommand(platform: NodeJS.Platform, pid: number): HelperCommand | undefined {
  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -Namespace Colony -Name Power -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);\'',
      // ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001); no ES_DISPLAY_REQUIRED.
      '$flags = [uint32]2147483649',
      'while ($true) {',
      '  [void][Colony.Power]::SetThreadExecutionState($flags)',
      `  if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { break }`,
      '  Start-Sleep -Seconds 15',
      '}',
    ].join('\n')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded] }
  }
  if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-i', '-w', String(pid)] }
  if (platform === 'linux') {
    return {
      cmd: 'systemd-inhibit',
      args: ['--what=sleep', '--who=Colony', '--why=Colony agents are working', '--mode=block', 'sh', '-c', `while kill -0 ${pid} 2>/dev/null; do sleep 20; done`],
    }
  }
  return undefined
}

export const defaultSpawner: Spawner = (cmd, args) => {
  const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: false })
  let done = false
  const cbs: ((code: number | null, error?: Error) => void)[] = []
  const finish = (code: number | null, error?: Error) => {
    if (done) return
    done = true
    for (const cb of cbs) cb(code, error)
  }
  child.once('error', (e) => finish(null, e))
  child.once('exit', (code) => finish(code))
  return {
    kill: () => { try { child.kill() } catch { /* already gone */ } },
    onExit: (cb) => { cbs.push(cb) },
  }
}

export const isKeepAwakeMode = (v: unknown): v is KeepAwakeMode => typeof v === 'string' && (KEEP_AWAKE_MODES as readonly string[]).includes(v)

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform
  spawner?: Spawner
  now?: () => number
  pid?: number
  releaseDelayMs?: number
  log?: { info(m: string): void; warn(m: string): void }
}

export class KeepAwake {
  private child?: HeldProcess
  private childStartedAt = 0
  private quickExits = 0
  private failed?: string
  private lastBusyAt?: number
  private timer?: NodeJS.Timeout
  private unsubscribe?: () => void
  private last = ''
  private readonly platform: NodeJS.Platform
  private readonly spawner: Spawner
  private readonly now: () => number
  private readonly pid: number
  private readonly releaseDelayMs: number
  private readonly log: { info(m: string): void; warn(m: string): void }

  constructor(private store: Store, private db: Db, o: KeepAwakeOptions = {}) {
    this.platform = o.platform ?? process.platform
    this.spawner = o.spawner ?? defaultSpawner
    this.now = o.now ?? Date.now
    this.pid = o.pid ?? process.pid
    this.releaseDelayMs = o.releaseDelayMs ?? RELEASE_DELAY_MS
    this.log = o.log ?? { info: () => {}, warn: () => {} }
  }

  mode(): KeepAwakeMode {
    const m = this.db.kvGet<{ mode?: unknown }>(KV)?.mode
    return isKeepAwakeMode(m) ? m : 'off'
  }

  setMode(mode: KeepAwakeMode): KeepAwakeState {
    this.db.kvSet(KV, { mode })
    this.failed = undefined
    this.quickExits = 0
    this.evaluate()
    return this.state()
  }

  get active() { return !!this.child }

  private busyCount() {
    let n = 0
    for (const r of this.store.agents.values()) if (BUSY.has(r.agent.status) && r.internal.desired !== 'paused') n++
    return n
  }

  /** Desired hold and the reason, from the mode and the agents. */
  private want(): { hold: boolean; reason: string } {
    const mode = this.mode()
    if (mode === 'off') return { hold: false, reason: 'Off' }
    if (mode === 'always') return { hold: true, reason: 'Always while Colony runs' }
    const busy = this.busyCount()
    const t = this.now()
    if (busy > 0) {
      this.lastBusyAt = t
      return { hold: true, reason: `${busy} agent${busy === 1 ? '' : 's'} working` }
    }
    if (this.lastBusyAt !== undefined && t - this.lastBusyAt < this.releaseDelayMs) {
      const min = Math.max(1, Math.ceil((this.releaseDelayMs - (t - this.lastBusyAt)) / 60_000))
      return { hold: true, reason: `Agents idle · releasing in ${min} min` }
    }
    this.lastBusyAt = undefined
    return { hold: false, reason: 'No agents working' }
  }

  state(): KeepAwakeState {
    const mode = this.mode()
    if (!helperCommand(this.platform, this.pid)) return { mode, active: false, reason: `Keep-awake is not supported on ${this.platform}`, unsupported: true }
    if (this.failed && mode !== 'off') return { mode, active: false, reason: this.failed, unsupported: true }
    const w = this.want()
    return { mode, active: this.active, reason: w.reason }
  }

  /** Start or stop the helper to match the mode and the agents. */
  evaluate() {
    const w = this.want()
    if (w.hold && !this.child && !this.failed) this.hold()
    else if (!w.hold && this.child) this.release()
    this.broadcastIfChanged()
  }

  private hold() {
    const h = helperCommand(this.platform, this.pid)
    if (!h) { this.failed = `Keep-awake is not supported on ${this.platform}`; return }
    let child: HeldProcess
    try {
      child = this.spawner(h.cmd, h.args)
    } catch (e) {
      this.failed = `Keep-awake helper failed to start: ${(e as Error).message}`
      this.log.warn(this.failed)
      return
    }
    this.child = child
    this.childStartedAt = this.now()
    this.log.info('keep-awake: holding the system awake')
    child.onExit((code, error) => {
      if (this.child !== child) return // released on purpose
      this.child = undefined
      if (error) this.failed = `Keep-awake helper unavailable (${h.cmd}: ${error.message})`
      else if (this.now() - this.childStartedAt < 10_000 && ++this.quickExits >= 2) this.failed = `Keep-awake helper keeps exiting (${h.cmd}, code ${code})`
      if (this.failed) this.log.warn(this.failed)
      this.evaluate() // respawn if still wanted (unless it failed)
    })
  }

  private release() {
    const c = this.child
    this.child = undefined
    c?.kill()
    this.log.info('keep-awake: released')
  }

  private broadcastIfChanged() {
    const s = JSON.stringify(this.state())
    if (s === this.last) return
    this.last = s
    this.store.broadcastResources()
  }

  /** Follow agent status changes, plus a slow tick for the release delay. */
  start(everyMs = 15_000) {
    this.stop()
    this.unsubscribe = this.store.subscribe((m) => {
      if ((m.type === 'agent_delta' && 'status' in m.patch) || m.type === 'snapshot') this.evaluate()
    })
    this.timer = setInterval(() => this.evaluate(), everyMs)
    this.timer.unref?.()
    process.once('exit', this.onProcessExit)
    this.evaluate()
  }

  private onProcessExit = () => { this.child?.kill() }

  /** Stop following and release the hold (control plane shutdown). */
  stop() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    process.removeListener('exit', this.onProcessExit)
    if (this.child) this.release()
  }
}

// ── routes ───────────────────────────────────────────────────────────────────

export function registerKeepAwakeRoutes(app: FastifyInstance, keepAwake: KeepAwake) {
  app.get('/api/keep-awake', async () => keepAwake.state())
  app.put('/api/keep-awake', async (req) => {
    const b = req.body
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw badRequest('body must be a JSON object')
    for (const k of Object.keys(b)) if (k !== 'mode') throw badRequest(`unknown field '${k}'`)
    const mode = (b as { mode?: unknown }).mode
    if (!isKeepAwakeMode(mode)) throw badRequest(`'mode' must be one of ${KEEP_AWAKE_MODES.join(', ')}`)
    return keepAwake.setMode(mode)
  })
}
