// Docker implementation of InfraDriver (dockerode). Topology: docs/phase1.md.
//
// Security posture of every Colony container:
//   - named volumes only (HostConfig.Mounts type 'volume'), no Binds, never the Docker socket
//   - not privileged, CapDrop ALL (git server adds back CHOWN only, for the one-off volume
//     ownership fix), no-new-privileges, non-root user `node` (uid 1000)
//   - memory / cpu / pids limits
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import Dockerode from 'dockerode'
import { execIn, type ExecResult } from './exec'
import {
  DIFF, ENSURE_REPO, LIST_BRANCHES, MERGE, MERGE_EXIT, PRE_RECEIVE_HOOK, REPO,
  BRANCH_LOG, LIST_REFS, RESET_BRANCH, RESET_EXIT, SET_REF,
} from './git-scripts'
import {
  ContainerNotRunningError, RefRejectedError,
  type AgentContainerSpec, type BranchInfo, type CommitInfo, type ContainerInfo, type ContainerStats, type InfraDriver,
  type MergeResult, type ShellHandle,
} from './types'
import {
  InfraValidationError, assertAgentId, assertBranch, assertEnv, assertMessage, assertRepoUrl,
  assertSlug, names, assertColonyRef, assertSha,
} from './validate'

export interface DockerDriverOptions {
  docker?: Dockerode
  /** Image for the git server container (default colony-agent:dev, which has git). */
  image?: string
  /** Override the agent container command (default `node /opt/colony/runner.mjs`). Tests use
   *  `['sleep', 'infinity']`. */
  agentCmd?: string[]
}

export interface DockerDriver extends InfraDriver {
  readonly docker: Dockerode
  /** Run argv in a container (Tty false). Exposed for diagnostics and tests. */
  exec(container: string, cmd: string[], opts?: { user?: string; timeoutMs?: number }): Promise<ExecResult>
}

const MB = 1024 * 1024
const DEFAULT_IMAGE = 'colony-agent:dev'
const DEFAULT_AGENT_CMD = ['node', '/opt/colony/runner.mjs']
const GIT_DAEMON_CMD = [
  'git', 'daemon', '--reuseaddr', '--base-path=/srv/git', '--export-all',
  '--enable=receive-pack', '--informative-errors', '/srv/git',
]

function defaultDocker(): Dockerode {
  // Same auto-detection the Phase 0 spike spelled out: DOCKER_HOST, else the named pipe on
  // Windows, else the unix socket.
  if (process.env.DOCKER_HOST) return new Dockerode()
  return new Dockerode({
    socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock',
  })
}

function statusCode(e: unknown): number | undefined {
  return (e as { statusCode?: number })?.statusCode
}

/** Swallow "not found" (404) and "already in that state" (304). */
async function ignoreMissing<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p
  } catch (e) {
    const code = statusCode(e)
    if (code === 404 || code === 304) return undefined
    throw e
  }
}

const sh = (script: string, ...args: string[]) => ['sh', '-c', script, 'colony', ...args]

export function createDockerDriver(opts: DockerDriverOptions = {}): DockerDriver {
  const docker = opts.docker ?? defaultDocker()
  const gitImage = opts.image ?? DEFAULT_IMAGE
  const agentCmd = opts.agentCmd ?? DEFAULT_AGENT_CMD

  const exec = (container: string, cmd: string[], o: { user?: string; timeoutMs?: number } = {}) =>
    execIn(docker, container, cmd, { user: o.user ?? 'node', timeoutMs: o.timeoutMs })

  async function gitExec(slug: string, cmd: string[], timeoutMs?: number): Promise<ExecResult> {
    return exec(names.gitContainer(slug), cmd, { timeoutMs })
  }

  async function mustOk(r: ExecResult, what: string): Promise<ExecResult> {
    if (r.exitCode !== 0) throw new Error(`${what} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`)
    return r
  }

  /** Real git check on top of the TS mirror. argv only, no shell. */
  async function checkBranch(slug: string, branch: string): Promise<void> {
    assertBranch(branch)
    const r = await gitExec(slug, ['git', 'check-ref-format', '--branch', branch])
    if (r.exitCode !== 0) throw new InfraValidationError(`invalid branch name: ${JSON.stringify(branch)}`)
  }

  async function ensureNetwork(slug: string): Promise<string> {
    const name = names.network(slug)
    const existing = await ignoreMissing(docker.getNetwork(name).inspect())
    if (existing) return name
    try {
      await docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        CheckDuplicate: true,
        Labels: { colony: '1', 'colony.project': slug },
      })
    } catch (e) {
      if (statusCode(e) !== 409) throw e
    }
    return name
  }

  async function ensureVolume(name: string, labels: Record<string, string>): Promise<void> {
    const existing = await ignoreMissing(docker.getVolume(name).inspect())
    if (existing) return
    await docker.createVolume({ Name: name, Labels: { colony: '1', ...labels } })
  }

  async function ensureGitContainer(slug: string, network: string): Promise<void> {
    const name = names.gitContainer(slug)
    const c = docker.getContainer(name)
    const info = await ignoreMissing(c.inspect())
    if (info) {
      if (!info.State.Running) await ignoreMissing(c.start())
      return
    }
    try {
      const created = await docker.createContainer({
        name,
        Image: gitImage,
        User: 'node',
        WorkingDir: '/srv/git',
        Cmd: GIT_DAEMON_CMD,
        Labels: { colony: '1', 'colony.project': slug, 'colony.kind': 'git' },
        HostConfig: {
          Mounts: [{ Type: 'volume', Source: names.gitVolume(slug), Target: '/srv/git' }],
          RestartPolicy: { Name: 'unless-stopped' },
          Memory: 256 * MB,
          MemorySwap: 256 * MB,
          NanoCpus: 500_000_000,
          PidsLimit: 256,
          Privileged: false,
          CapDrop: ['ALL'],
          CapAdd: ['CHOWN'],           // only for the root chown of a fresh volume
          SecurityOpt: ['no-new-privileges'],
          NetworkMode: network,
        },
        NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: ['git'] } } },
      })
      await created.start()
    } catch (e) {
      if (statusCode(e) !== 409) throw e   // created concurrently
      await ignoreMissing(c.start())
    }
  }

  const driver: DockerDriver = {
    docker,
    exec,

    async ping() {
      try {
        await docker.ping()
        return true
      } catch {
        return false
      }
    },

    async ensureProject(slug, o = {}) {
      assertSlug(slug)
      const repoUrl = o.repoUrl ? assertRepoUrl(o.repoUrl) : ''
      const projectName = (o.projectName ?? slug).replace(/[\r\n\0]/g, ' ').slice(0, 200)
      const network = await ensureNetwork(slug)
      await ensureVolume(names.gitVolume(slug), { 'colony.project': slug, 'colony.kind': 'git' })
      await ensureGitContainer(slug, network)
      const gitName = names.gitContainer(slug)
      // A fresh named volume is root-owned (the image has no /srv/git to copy ownership from).
      const own = await exec(gitName, ['stat', '-c', '%u', '/srv/git'])
      if (own.stdout.trim() !== '1000') {
        await mustOk(await exec(gitName, ['chown', '1000:1000', '/srv/git'], { user: 'root' }), 'chown /srv/git')
      }
      await mustOk(await gitExec(slug, sh(ENSURE_REPO, repoUrl, projectName, PRE_RECEIVE_HOOK), 600_000), 'init bare repo')
    },

    async removeProject(slug, o = {}) {
      assertSlug(slug)
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`colony.project=${slug}`] },
      })
      await Promise.all(containers.map((c) => ignoreMissing(docker.getContainer(c.Id).remove({ force: true }))))
      await ignoreMissing(docker.getNetwork(names.network(slug)).remove())
      if (o.purge) {
        const { Volumes } = await docker.listVolumes({ filters: { label: [`colony.project=${slug}`] } })
        const vols = new Set((Volumes ?? []).map((v) => v.Name))
        vols.add(names.gitVolume(slug))
        await Promise.all([...vols].map((v) => ignoreMissing(docker.getVolume(v).remove({ force: true }))))
      }
    },

    async startAgent(spec: AgentContainerSpec) {
      assertSlug(spec.projectSlug)
      assertAgentId(spec.agentId)
      const env = assertEnv(spec.env)
      if (!spec.image || typeof spec.image !== 'string') throw new InfraValidationError('image is required')
      const memoryMb = spec.memoryMb > 0 ? spec.memoryMb : 2048
      const cpus = spec.cpus > 0 ? spec.cpus : 2
      const network = names.network(spec.projectSlug)
      if (!(await ignoreMissing(docker.getNetwork(network).inspect()))) {
        throw new Error(`project network ${network} does not exist; call ensureProject first`)
      }
      const name = names.agentContainer(spec.agentId)
      await ignoreMissing(docker.getContainer(name).remove({ force: true }))
      await ensureVolume(names.agentVolume(spec.agentId), {
        'colony.project': spec.projectSlug, 'colony.agent': spec.agentId, 'colony.kind': 'agent',
      })
      const c = await docker.createContainer({
        name,
        Image: spec.image,
        User: 'node',
        WorkingDir: '/workspace',
        Env: env,
        Cmd: agentCmd,
        Labels: {
          colony: '1', 'colony.project': spec.projectSlug, 'colony.agent': spec.agentId, 'colony.kind': 'agent',
        },
        HostConfig: {
          Mounts: [{ Type: 'volume', Source: names.agentVolume(spec.agentId), Target: '/workspace' }],
          Memory: memoryMb * MB,
          MemorySwap: memoryMb * MB,
          NanoCpus: Math.round(cpus * 1e9),
          PidsLimit: 2048,
          Privileged: false,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          ExtraHosts: ['host.docker.internal:host-gateway'],
          NetworkMode: network,
          RestartPolicy: { Name: 'no' },
        },
      })
      await c.start()
      return { name }
    },

    async stopAgent(agentId, o = {}) {
      assertAgentId(agentId)
      const c = docker.getContainer(names.agentContainer(agentId))
      await ignoreMissing(c.stop({ t: 10 }))
      if (o.remove) await ignoreMissing(c.remove({ force: true }))
    },

    async removeAgentVolume(agentId) {
      assertAgentId(agentId)
      await ignoreMissing(docker.getVolume(names.agentVolume(agentId)).remove({ force: true }))
    },

    async agentStats(agentId): Promise<ContainerStats | null> {
      assertAgentId(agentId)
      const c = docker.getContainer(names.agentContainer(agentId))
      const info = await ignoreMissing(c.inspect())
      if (!info) return null
      const memLimitMb = (info.HostConfig.Memory ?? 0) / MB
      if (!info.State.Running) return { running: false, cpuPct: 0, memMb: 0, memLimitMb }
      // stream:false samples twice (~1 s apart), so precpu_stats is populated.
      const s = (await c.stats({ stream: false })) as unknown as Dockerode.ContainerStats
      return { running: true, ...computeStats(s) }
    },

    async listContainers(): Promise<ContainerInfo[]> {
      const list = await docker.listContainers({ all: true, filters: { label: ['colony=1'] } })
      return list.map((c) => {
        const l = c.Labels ?? {}
        const kind: ContainerInfo['kind'] =
          l['colony.kind'] === 'agent' || l['colony.agent'] ? 'agent' : l['colony.kind'] === 'git' ? 'git' : 'other'
        return {
          name: (c.Names?.[0] ?? c.Id).replace(/^\//, ''),
          agentId: l['colony.agent'] || undefined,
          projectSlug: l['colony.project'] || undefined,
          kind,
          running: c.State === 'running',
        }
      })
    },

    async listBranches(slug): Promise<BranchInfo[]> {
      assertSlug(slug)
      const r = await mustOk(await gitExec(slug, sh(LIST_BRANCHES)), 'list branches')
      return parseBranchList(r.stdout)
    },

    async diff(slug, branch) {
      assertSlug(slug)
      await checkBranch(slug, branch)
      const r = await mustOk(await gitExec(slug, sh(DIFF, branch)), `diff ${branch}`)
      return r.stdout
    },

    async mergeToMain(slug, branch, message): Promise<MergeResult> {
      assertSlug(slug)
      assertMessage(message)
      await checkBranch(slug, branch)
      if (branch === 'main') return { ok: false, conflict: false, message: 'cannot merge main into itself' }
      const r = await gitExec(slug, sh(MERGE, branch, message), 300_000)
      const detail = (r.stderr.trim() || r.stdout.trim()).slice(-2000)
      switch (r.exitCode) {
        case 0:
          return { ok: true, sha: r.stdout.trim().split('\n').pop()!, message: `merged ${branch} into main` }
        case MERGE_EXIT.upToDate:
          return { ok: true, sha: r.stdout.trim().split('\n').pop()!, message: `${branch} is already merged; main unchanged` }
        case MERGE_EXIT.conflict:
          return { ok: false, conflict: true, message: `merge conflict merging ${branch} into main:\n${detail}` }
        case MERGE_EXIT.noBranch:
          return { ok: false, conflict: false, message: `no such branch: ${branch}` }
        case MERGE_EXIT.refMoved:
          return { ok: false, conflict: false, message: 'main moved during the merge; retry' }
        default:
          return { ok: false, conflict: false, message: `merge failed (exit ${r.exitCode}): ${detail}` }
      }
    },
    // ── Phase 6: checkpoints and revert ──
    async branchLog(slug, branch, limit): Promise<CommitInfo[]> {
      assertSlug(slug)
      await checkBranch(slug, branch)
      const n = Math.max(1, Math.min(200, Math.floor(limit)))
      const r = await mustOk(await gitExec(slug, sh(BRANCH_LOG, branch, String(n))), `log ${branch}`)
      return parseBranchLog(r.stdout)
    },

    async listRefs(slug, prefix) {
      assertSlug(slug)
      assertColonyRef(prefix, { prefix: true })
      const r = await mustOk(await gitExec(slug, sh(LIST_REFS, prefix)), 'list refs')
      return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [ref, sha] = l.split(' ')
        return { ref, sha }
      })
    },

    async setRef(slug, ref, sha) {
      assertSlug(slug)
      assertColonyRef(ref)
      assertSha(sha)
      await mustOk(await gitExec(slug, sh(SET_REF, ref, sha)), `set ${ref}`)
    },

    async resetBranch(slug, branch, o) {
      assertSlug(slug)
      await checkBranch(slug, branch)
      if (branch === 'main') throw new RefRejectedError('refusing to move main')
      assertSha(o.to)
      assertSha(o.expect)
      assertColonyRef(o.backupRef)
      const r = await gitExec(slug, sh(RESET_BRANCH, branch, o.to, o.expect, o.backupRef, o.allowAnyTarget ? '1' : '0'))
      const detail = (r.stderr.trim() || r.stdout.trim()).slice(-500)
      if (r.exitCode === 0) return { from: r.stdout.trim().split('\n').pop()!, to: o.to }
      const refused: number[] = [RESET_EXIT.moved, RESET_EXIT.notAncestor, RESET_EXIT.behindMain, RESET_EXIT.noCommit, RESET_EXIT.noBranch]
      if (refused.includes(r.exitCode)) throw new RefRejectedError(detail || `revert refused (exit ${r.exitCode})`)
      throw new Error(`revert ${branch} failed (exit ${r.exitCode}): ${detail}`)
    },

    async execInAgent(agentId, cmd, o = {}) {
      assertAgentId(agentId)
      if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((a) => typeof a !== 'string')) {
        throw new InfraValidationError('cmd must be a non-empty argv array')
      }
      return exec(names.agentContainer(agentId), cmd, { user: 'node', timeoutMs: o.timeoutMs ?? 30_000 })
    },

    async openShell(agentId, o): Promise<ShellHandle> {
      assertAgentId(agentId)
      const cols = clampSize(o.cols, 80), rows = clampSize(o.rows, 24)
      const c = docker.getContainer(names.agentContainer(agentId))
      const info = await ignoreMissing(c.inspect())
      if (!info?.State?.Running) throw new ContainerNotRunningError(`agent container for ${agentId} is not running`)
      // Docker does not hang up the pty when the hijacked connection closes, and exec sessions
      // cannot be killed through the API (spikes/03-pty gotcha 1). So the shell records its pid
      // (`exec` keeps it) and kill() signals it from a second exec.
      const pidFile = `/tmp/colony-pty-${agentId}-${randomBytes(6).toString('hex')}.pid`
      const e = await c.exec({
        Cmd: ['bash', '-c', `echo $$ > ${pidFile}; exec bash -l`],
        AttachStdin: true, AttachStdout: true, AttachStderr: true,
        Tty: true,
        User: 'node',
        WorkingDir: '/workspace',
        Env: ['TERM=xterm-256color'],
        ConsoleSize: [rows, cols],
      })
      // ConsoleSize at start (API >= 1.42) lays out the first prompt; resize() covers older engines.
      const stream = (await e.start({ hijack: true, stdin: true, Tty: true, ConsoleSize: [rows, cols] } as Dockerode.ExecStartOptions)) as Duplex
      await e.resize({ w: cols, h: rows }).catch(() => {})
      let killed: Promise<void> | undefined
      return {
        stream,
        async resize(w, h) {
          await e.resize({ w: clampSize(w, 80), h: clampSize(h, 24) })
        },
        kill() {
          killed ??= (async () => {
            const script = `p=$(cat ${pidFile} 2>/dev/null) || exit 0; kill -HUP "$p" 2>/dev/null; ` +
              'for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done; ' +
              `kill -KILL "$p" 2>/dev/null; rm -f ${pidFile}`
            try {
              const k = await c.exec({ Cmd: ['sh', '-c', script], User: 'node', AttachStdout: false, AttachStderr: false })
              // Detached start still answers with a (empty) response stream; drain it or its
              // socket stays open and keeps the process alive.
              const res = (await k.start({ Detach: true })) as unknown as NodeJS.ReadableStream | undefined
              res?.resume?.()
            } catch (err) {
              // Container gone (or stopped): the shell went with it.
              if (statusCode(err) !== 404 && statusCode(err) !== 409) throw err
            } finally {
              try { stream.end() } catch { /* closed */ }
              try { stream.destroy() } catch { /* closed */ }
            }
          })()
          return killed
        },
      }
    },
  }
  return driver
}

const clampSize = (n: number, d: number) => (Number.isInteger(n) && n >= 1 ? Math.min(n, 1000) : d)

/** `<name> <sha> <behind> <ahead>` lines from LIST_BRANCHES. */
export function parseBranchLog(out: string): CommitInfo[] {
  const res: CommitInfo[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [sha, ts, inMain, ...rest] = line.split('\t')
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue
    res.push({ sha, at: new Date(Number(ts) * 1000).toISOString(), inMain: inMain === '1', subject: rest.join('\t') })
  }
  return res
}

export function parseBranchList(out: string): BranchInfo[] {
  const res: BranchInfo[] = []
  for (const line of out.split('\n')) {
    const p = line.trim().split(/\s+/)
    if (p.length !== 4) continue
    res.push({ name: p[0], sha: p[1], behindMain: Number(p[2]) || 0, aheadOfMain: Number(p[3]) || 0 })
  }
  return res
}

/** CPU% as `docker stats` computes it: container cpu delta / system cpu delta * online cpus. */
export function computeStats(s: Dockerode.ContainerStats): Omit<ContainerStats, 'running'> {
  const cpu = s.cpu_stats
  const pre = s.precpu_stats
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0)
  const sysDelta = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0)
  const online = cpu?.online_cpus || cpu?.cpu_usage?.percpu_usage?.length || 1
  const cpuPct = cpuDelta > 0 && sysDelta > 0 ? (cpuDelta / sysDelta) * online * 100 : 0
  const m = s.memory_stats ?? ({} as Dockerode.ContainerStats['memory_stats'])
  const stats = (m?.stats ?? {}) as unknown as Record<string, number>
  // cgroup v2: inactive_file; v1: total_inactive_file. Same subtraction the docker CLI does.
  const cache = stats.inactive_file ?? stats.total_inactive_file ?? 0
  const used = Math.max(0, (m?.usage ?? 0) - cache)
  return {
    cpuPct: Math.round(cpuPct * 100) / 100,
    memMb: Math.round((used / MB) * 10) / 10,
    memLimitMb: Math.round(((m?.limit ?? 0) / MB) * 10) / 10,
  }
}

export { REPO }
