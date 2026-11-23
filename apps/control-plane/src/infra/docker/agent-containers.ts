// Agent containers: start/stop, stats, listing, exec and the interactive shell (pty).
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type Dockerode from 'dockerode'
import {
  ContainerNotRunningError,
  type AgentContainerSpec, type ContainerInfo, type ContainerStats, type InfraDriver, type ShellHandle,
} from '../types'
import { InfraValidationError, assertAgentId, assertEnv, assertSlug, names } from '../validate'
import { MB, ignoreMissing, statusCode, type DockerCtx } from './common'

type AgentMethods = Pick<InfraDriver,
  'startAgent' | 'stopAgent' | 'imageId' | 'removeAgentVolume' | 'agentStats' | 'listContainers' | 'execInAgent' | 'openShell'>

export function agentContainerMethods(ctx: DockerCtx): AgentMethods {
  const { docker, agentCmd, exec, ensureVolume } = ctx
  return {
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

    async imageId(image) {
      const info = await ignoreMissing(docker.getImage(image).inspect())
      return info?.Id
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
}

const clampSize = (n: number, d: number) => (Number.isInteger(n) && n >= 1 ? Math.min(n, 1000) : d)

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
