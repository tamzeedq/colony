// Local-access sidecars (feedback #19): read-only repo access and dev-server previews, bound to
// 127.0.0.1 only.
import type { InfraDriver } from '../types'
import { InfraValidationError, assertAgentId, assertSlug, names } from '../validate'
import { MB, ignoreMissing, type DockerCtx } from './common'

type AccessMethods = Pick<InfraDriver, 'exposeRepo' | 'unexposeRepo' | 'startPreview' | 'stopPreview'>

export function localAccessMethods(ctx: DockerCtx): AccessMethods {
  const { docker, gitImage } = ctx
  return {
    // ── feedback #19: local access sidecars (127.0.0.1 only) ──
    async exposeRepo(slug, hostPort) {
      assertSlug(slug)
      assertPort(hostPort)
      const name = names.repoSidecar(slug)
      await ignoreMissing(docker.getContainer(name).remove({ force: true }))
      const c = await docker.createContainer({
        name, Image: gitImage, User: 'node', WorkingDir: '/srv/git',
        // No --enable=receive-pack: fetch/clone only. The volume is mounted read-only too.
        Cmd: ['git', 'daemon', '--reuseaddr', '--base-path=/srv/git', '--export-all', '--informative-errors', '/srv/git'],
        Labels: { colony: '1', 'colony.project': slug, 'colony.kind': 'repo-access' },
        ExposedPorts: { '9418/tcp': {} },
        HostConfig: {
          ...sidecarHardening(names.network(slug)),
          Mounts: [{ Type: 'volume', Source: names.gitVolume(slug), Target: '/srv/git', ReadOnly: true }],
          PortBindings: { '9418/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] },
        },
      })
      await c.start()
      return { name }
    },

    async unexposeRepo(slug) {
      assertSlug(slug)
      await ignoreMissing(docker.getContainer(names.repoSidecar(slug)).remove({ force: true }))
    },

    async startPreview(slug, agentId, targetPort, hostPort) {
      assertSlug(slug)
      assertAgentId(agentId)
      assertPort(targetPort)
      assertPort(hostPort)
      const name = names.previewSidecar(agentId)
      await ignoreMissing(docker.getContainer(name).remove({ force: true }))
      const c = await docker.createContainer({
        name, Image: gitImage, User: 'node',
        Env: [`COLONY_TARGET_HOST=${names.agentContainer(agentId)}`, `COLONY_TARGET_PORT=${targetPort}`],
        Cmd: ['node', '-e', PREVIEW_PROXY],
        Labels: { colony: '1', 'colony.project': slug, 'colony.kind': 'preview', 'colony.preview-for': agentId },
        ExposedPorts: { '8080/tcp': {} },
        HostConfig: {
          ...sidecarHardening(names.network(slug)),
          PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] },
        },
      })
      await c.start()
      return { name }
    },

    async stopPreview(agentId) {
      assertAgentId(agentId)
      await ignoreMissing(docker.getContainer(names.previewSidecar(agentId)).remove({ force: true }))
    },
  }
}

/** A plain TCP forwarder (port 8080 → the agent's dev server), run with `node -e`. */
const PREVIEW_PROXY = [
  "const net = require('net')",
  "const host = process.env.COLONY_TARGET_HOST, port = Number(process.env.COLONY_TARGET_PORT)",
  "net.createServer((c) => { const u = net.connect(port, host); c.pipe(u).pipe(c);",
  "  const end = () => { c.destroy(); u.destroy() }; u.on('error', end); c.on('error', end) }).listen(8080, '0.0.0.0')",
].join('\n')

function sidecarHardening(network: string) {
  return {
    Memory: 128 * MB, MemorySwap: 128 * MB, NanoCpus: 500_000_000, PidsLimit: 128,
    Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
    NetworkMode: network, RestartPolicy: { Name: 'no' as const },
  }
}

function assertPort(p: number) {
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new InfraValidationError(`invalid port: ${p}`)
}
