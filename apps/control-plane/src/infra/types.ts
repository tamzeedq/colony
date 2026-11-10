// Contract between the control plane and Docker. The Docker implementation lives in
// ./docker.ts, an in-memory fake in ./fake.ts. See docs/phase1.md for the topology.

export interface AgentContainerSpec {
  agentId: string
  projectSlug: string
  image: string                   // 'colony-agent:dev'
  env: Record<string, string>     // see docs/phase1.md "Agent container environment"
  memoryMb: number                // default 2048
  cpus: number                    // default 2
}

export interface ContainerInfo {
  name: string
  agentId?: string
  projectSlug?: string
  kind: 'agent' | 'git' | 'other'
  running: boolean
}

export interface ContainerStats {
  running: boolean
  cpuPct: number
  memMb: number
  memLimitMb: number
}

export interface BranchInfo {
  name: string
  sha: string
  aheadOfMain: number
  behindMain: number
}

export type MergeResult =
  | { ok: true; sha: string; message: string }
  | { ok: false; conflict: boolean; message: string }

export interface InfraDriver {
  /** Docker reachable? */
  ping(): Promise<boolean>

  /** Network colony-proj-<slug> + git server container colony-git-<slug> (alias `git`) +
   *  bare repo with a main-protecting pre-receive hook. Idempotent. With repoUrl, the bare
   *  repo is cloned from it; otherwise initialised with one commit on main (README.md). */
  ensureProject(slug: string, opts?: { repoUrl?: string; projectName?: string }): Promise<void>

  /** Remove the project's containers and network; with purge, also its volumes. */
  removeProject(slug: string, opts?: { purge?: boolean }): Promise<void>

  /** Create (or recreate) and start colony-agent-<agentId> on the project network with volume
   *  colony-ws-<agentId> at /workspace. Returns the container name. */
  startAgent(spec: AgentContainerSpec): Promise<{ name: string }>

  /** Stop the agent container; with remove, delete the container (volume kept). */
  stopAgent(agentId: string, opts?: { remove?: boolean }): Promise<void>

  /** Delete the agent's workspace volume. */
  removeAgentVolume(agentId: string): Promise<void>

  agentStats(agentId: string): Promise<ContainerStats | null>

  /** Everything labelled colony=1. */
  listContainers(): Promise<ContainerInfo[]>

  listBranches(slug: string): Promise<BranchInfo[]>
  diff(slug: string, branch: string): Promise<string>        // unified diff main...branch

  /** Merge branch into main inside the git container (no-ff). Callers MUST have checked
   *  canMergeToMain() first; the driver never decides approval itself. */
  mergeToMain(slug: string, branch: string, message: string): Promise<MergeResult>
}
