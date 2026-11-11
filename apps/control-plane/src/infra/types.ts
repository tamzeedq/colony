// Contract between the control plane and Docker. The Docker implementation lives in
// ./docker.ts, an in-memory fake in ./fake.ts. See docs/phase1.md for the topology.

import type { Duplex } from 'node:stream'

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

  // ── optional Phase 2 capabilities (Docker driver and fake implement both) ──

  /** Open an interactive shell in the agent container. Throws ContainerNotRunningError if
   *  the container is not running. */
  openShell?(agentId: string, opts: ShellOptions): Promise<ShellHandle>

  /** Run argv in the agent container as `node` (Tty false) and collect the output. */
  execInAgent?(agentId: string, cmd: string[], opts?: { timeoutMs?: number }): Promise<AgentExecResult>

  // ── optional Phase 6 capabilities: checkpoints and revert (docs/phase6.md) ──

  /** Newest-first commits on a branch. */
  branchLog?(slug: string, branch: string, limit: number): Promise<CommitInfo[]>
  /** Refs under a prefix such as refs/colony/checkpoints/<agentId>/. */
  listRefs?(slug: string, prefix: string): Promise<{ ref: string; sha: string }[]>
  /** Point a refs/colony/... ref at a commit. */
  setRef?(slug: string, ref: string, sha: string): Promise<void>
  /** Move an agent branch to `to` (CAS on `expect`), saving the old head in `backupRef`.
   *  Throws RefRejectedError when a guard fails. Never moves main. */
  resetBranch?(slug: string, branch: string, opts: { to: string; expect: string; backupRef: string; allowAnyTarget?: boolean }): Promise<{ from: string; to: string }>

  // ── optional Phase 6 capability (docs/phase6.md "GitHub") ──

  /** Push `srcRef` of the project's bare repo to `dstRef` (a branch name) on an https remote,
   *  from the git container, without --force. The token only travels in the exec's
   *  environment; it is never in argv and never written to git config. */
  pushToRemote?(slug: string, opts: PushToRemoteOptions): Promise<PushResult>
}

export interface CommitInfo {
  sha: string
  /** ISO time of the commit. */
  at: string
  subject: string
  /** Already reachable from main. */
  inMain: boolean
}

/** A checkpoint/revert guard refused the change (not an infrastructure failure). */
export class RefRejectedError extends Error {
  override name = 'RefRejectedError'
}

// ── Phase 6: publishing to GitHub ─────────────────────────────────────────────

export interface PushToRemoteOptions {
  /** https URL of the remote, e.g. https://github.com/owner/name.git (no credentials). */
  url: string
  /** Local ref to push, e.g. refs/heads/main. */
  srcRef: string
  /** Remote branch name (refs/heads/<dstRef>). */
  dstRef: string
  /** Sent as `Authorization: Basic base64(x-access-token:<token>)`. */
  token: string
}

export type PushResult =
  | { ok: true; sha: string; message: string }
  | { ok: false; reason: 'non_fast_forward' | 'no_ref' | 'failed'; message: string }

// ── Phase 2: interactive shells and one-off commands in agent containers ─────

export interface ShellOptions {
  cols: number
  rows: number
}

/** An interactive login shell (`bash -l` as `node` in /workspace) on a PTY in the agent's
 *  container. `stream` is raw PTY bytes both ways (no multiplexing). */
export interface ShellHandle {
  stream: Duplex
  resize(cols: number, rows: number): Promise<void>
  /** Kill the shell inside the container (SIGHUP, SIGKILL after 2 s) and end the stream.
   *  Closing the stream alone does NOT end the shell (spikes/03-pty gotcha 1). Idempotent. */
  kill(): Promise<void>
}

export interface AgentExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Thrown by openShell when the agent's container is missing or not running. */
export class ContainerNotRunningError extends Error {
  override name = 'ContainerNotRunningError'
}
