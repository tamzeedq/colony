// Shared plumbing for the Docker driver modules: the dockerode handle, exec helpers, and the
// small utilities every container module needs.
import Dockerode from 'dockerode'
import { execIn, type ExecResult } from '../exec'
import { names } from '../validate'

export const MB = 1024 * 1024
export const DEFAULT_IMAGE = 'colony-agent:dev'
export const DEFAULT_AGENT_CMD = ['node', '/opt/colony/runner.mjs']
export const GIT_DAEMON_CMD = [
  'git', 'daemon', '--reuseaddr', '--base-path=/srv/git', '--export-all',
  '--enable=receive-pack', '--informative-errors', '/srv/git',
]

export function defaultDocker(): Dockerode {
  // Same auto-detection the Phase 0 spike spelled out: DOCKER_HOST, else the named pipe on
  // Windows, else the unix socket.
  if (process.env.DOCKER_HOST) return new Dockerode()
  return new Dockerode({
    socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock',
  })
}

export function statusCode(e: unknown): number | undefined {
  return (e as { statusCode?: number })?.statusCode
}

/** Swallow "not found" (404) and "already in that state" (304). */
export async function ignoreMissing<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p
  } catch (e) {
    const code = statusCode(e)
    if (code === 404 || code === 304) return undefined
    throw e
  }
}

export const sh = (script: string, ...args: string[]) => ['sh', '-c', script, 'colony', ...args]

export type ExecFn = (container: string, cmd: string[], opts?: { user?: string; timeoutMs?: number }) => Promise<ExecResult>

/** What each driver module needs: the docker handle, images/commands, and exec helpers. */
export interface DockerCtx {
  docker: Dockerode
  gitImage: string
  agentCmd: string[]
  exec: ExecFn
  gitExec(slug: string, cmd: string[], timeoutMs?: number): Promise<ExecResult>
  mustOk(r: ExecResult, what: string): Promise<ExecResult>
  ensureVolume(name: string, labels: Record<string, string>): Promise<void>
}

export function makeCtx(docker: Dockerode, gitImage: string, agentCmd: string[]): DockerCtx {
  const exec: ExecFn = (container: string, cmd: string[], o: { user?: string; timeoutMs?: number } = {}) =>
    execIn(docker, container, cmd, { user: o.user ?? 'node', timeoutMs: o.timeoutMs })

  async function gitExec(slug: string, cmd: string[], timeoutMs?: number): Promise<ExecResult> {
    return exec(names.gitContainer(slug), cmd, { timeoutMs })
  }

  async function mustOk(r: ExecResult, what: string): Promise<ExecResult> {
    if (r.exitCode !== 0) throw new Error(`${what} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`)
    return r
  }

  async function ensureVolume(name: string, labels: Record<string, string>): Promise<void> {
    const existing = await ignoreMissing(docker.getVolume(name).inspect())
    if (existing) return
    await docker.createVolume({ Name: name, Labels: { colony: '1', ...labels } })
  }

  return { docker, gitImage, agentCmd, exec, gitExec, mustOk, ensureVolume }
}
