// Docker implementation of InfraDriver (dockerode). Topology: docs/phase1.md.
//
// Security posture of every Colony container:
//   - named volumes only (HostConfig.Mounts type 'volume'), no Binds, never the Docker socket
//   - not privileged, CapDrop ALL (git server adds back CHOWN only, for the one-off volume
//     ownership fix), no-new-privileges, non-root user `node` (uid 1000)
//   - memory / cpu / pids limits
//
// Split by concern (this file composes them):
//   docker/common.ts           shared dockerode plumbing and exec helpers
//   docker/agent-containers.ts agent containers: start/stop/stats/exec/shell
//   docker/git-server.ts       project network + git daemon, git operations, branch parsers
//   docker/local-access.ts     127.0.0.1 repo-access and preview sidecars
import type Dockerode from 'dockerode'
import { type ExecResult } from './exec'
import { REPO } from './git-scripts'
import type { InfraDriver } from './types'
import { agentContainerMethods } from './docker/agent-containers'
import { DEFAULT_AGENT_CMD, DEFAULT_IMAGE, defaultDocker, makeCtx } from './docker/common'
import { gitServerMethods } from './docker/git-server'
import { localAccessMethods } from './docker/local-access'

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

export function createDockerDriver(opts: DockerDriverOptions = {}): DockerDriver {
  const docker = opts.docker ?? defaultDocker()
  const ctx = makeCtx(docker, opts.image ?? DEFAULT_IMAGE, opts.agentCmd ?? DEFAULT_AGENT_CMD)

  const driver: DockerDriver = {
    docker,
    exec: ctx.exec,

    async ping() {
      try {
        await docker.ping()
        return true
      } catch {
        return false
      }
    },

    ...gitServerMethods(ctx),
    ...agentContainerMethods(ctx),
    ...localAccessMethods(ctx),
  }
  return driver
}

export { parseBranchList, parseBranchLog } from './docker/git-server'
export { computeStats } from './docker/agent-containers'
export { REPO }
