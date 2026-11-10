// One `claude -p` child process speaking stream-json on stdin/stdout.
// Pure process plumbing: line splitting, stdin writes, stderr tail, exit/kill.
// Policy (restarts, statuses, mapping) lives in runner.ts.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import type { Logger } from './log'

export interface ClaudeArgsOptions {
  model: string
  systemPrompt?: string
  resume?: string
  mcpConfigPath?: string
}

/** Argument list for the long-lived CLI (docs/phase1.md step 3). */
export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--model', o.model,
  ]
  if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt)
  if (o.resume) args.push('--resume', o.resume)
  if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath)
  return args
}

const STDERR_TAIL_CHARS = 4000

export interface ClaudeExit {
  code: number | null
  signal: NodeJS.Signals | null
  /** Spawn failure (e.g. ENOENT), if the process never started. */
  error?: Error
}

export declare interface ClaudeProcess {
  on(event: 'line', fn: (line: string) => void): this
  on(event: 'exit', fn: (exit: ClaudeExit) => void): this
}

export class ClaudeProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams
  private stderrBuf = ''
  private exitInfo: ClaudeExit | undefined
  private readonly exited: Promise<ClaudeExit>
  readonly startedAt = Date.now()
  readonly args: string[]

  constructor(bin: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; log: Logger }) {
    super()
    this.args = args
    // A JS file as the binary (tests, local fakes) is run with the current node.
    const isScript = /\.(m|c)?js$/i.test(bin)
    const cmd = isScript ? process.execPath : bin
    const argv = isScript ? [bin, ...args] : args
    this.child = spawn(cmd, argv, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

    let resolveExit!: (e: ClaudeExit) => void
    this.exited = new Promise((r) => { resolveExit = r })
    const finish = (e: ClaudeExit) => {
      if (this.exitInfo) return
      this.exitInfo = e
      resolveExit(e)
      // Let any trailing stdout lines drain before announcing the exit.
      setImmediate(() => this.emit('exit', e))
    }

    this.child.on('error', (error) => finish({ code: null, signal: null, error }))
    this.child.on('close', (code, signal) => finish({ code, signal }))

    // Writes after the child died raise EPIPE on stdin; the exit path handles the rest.
    this.child.stdin.on('error', (err) => opts.log.warn('claude stdin error', err))

    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (line.trim()) this.emit('line', line)
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrBuf = (this.stderrBuf + chunk).slice(-STDERR_TAIL_CHARS)
      for (const l of chunk.split(/\r?\n/)) if (l.trim()) opts.log.warn(`claude stderr: ${l.slice(0, 500)}`)
    })
  }

  get pid(): number | undefined { return this.child.pid }
  get alive(): boolean { return this.exitInfo === undefined }
  get stderrTail(): string { return this.stderrBuf }
  waitExit(): Promise<ClaudeExit> { return this.exited }

  /** Write one JSON message as a line. Returns false if the process is gone. */
  write(msg: unknown): boolean {
    if (!this.alive || this.child.stdin.destroyed || this.child.stdin.writableEnded) return false
    this.child.stdin.write(`${JSON.stringify(msg)}\n`)
    return true
  }

  writeUserMessage(text: string): boolean {
    return this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
  }

  endInput(): void {
    if (!this.child.stdin.writableEnded) this.child.stdin.end()
  }

  kill(signal: NodeJS.Signals): void {
    if (this.alive) this.child.kill(signal)
  }

  /** Close stdin, wait `graceMs`, then SIGTERM, then SIGKILL. Resolves on exit. */
  async stop(graceMs: number): Promise<ClaudeExit> {
    this.endInput()
    const waitFor = (ms: number) => Promise.race([this.exited, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())])
    const a = await waitFor(graceMs)
    if (a) return a
    this.kill('SIGTERM')
    const b = await waitFor(3000)
    if (b) return b
    this.kill('SIGKILL')
    return this.exited
  }
}
