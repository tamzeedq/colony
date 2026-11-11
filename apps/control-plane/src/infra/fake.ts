// In-memory InfraDriver for server tests. Records every call, simulates projects, agent
// containers, branches and merges, and can be told to fail or conflict.
import { randomBytes } from 'node:crypto'
import { Duplex } from 'node:stream'
import {
  ContainerNotRunningError,
  type AgentContainerSpec, type AgentExecResult, type BranchInfo, type ContainerInfo, type ContainerStats,
  type InfraDriver, type MergeResult, type PushResult, type ShellHandle,
} from './types'
import { assertAgentId, assertBranch, assertLocalRef, assertMessage, assertPushUrl, assertSlug, names } from './validate'

/** A push recorded by pushToRemote (Phase 6). `token` is kept so tests can check it was
 *  passed; `calls` records it masked. */
export interface FakePush {
  slug: string
  url: string
  srcRef: string
  dstRef: string
  token: string
  sha: string
}

export interface FakeCall {
  method: keyof InfraDriver
  args: unknown[]
}

export interface FakeBranch {
  sha: string
  aheadOfMain: number
  behindMain: number
  diff: string
  /** mergeToMain on this branch reports a conflict. */
  conflict?: boolean
}

export interface FakeProject {
  slug: string
  repoUrl?: string
  projectName?: string
  mainSha: string
  branches: Map<string, FakeBranch>
}

export interface FakeAgent {
  spec: AgentContainerSpec
  running: boolean
  volume: boolean
}

/** A fake interactive shell: echoes every input byte back as output. */
export interface FakeShell {
  agentId: string
  cols: number
  rows: number
  resizes: [number, number][]
  /** Everything written to the shell (terminal input). */
  input: string
  killed: boolean
  handle: ShellHandle
  /** Simulate the shell exiting on its own (ends the output stream). */
  exit(): void
}

export type FakeExecHandler = (agentId: string, cmd: string[]) => AgentExecResult | Promise<AgentExecResult>

export interface FakeDriverOptions {
  ping?: boolean
  stats?: Omit<ContainerStats, 'running' | 'memLimitMb'>
}

export interface FakeDriver extends InfraDriver {
  calls: FakeCall[]
  projects: Map<string, FakeProject>
  agents: Map<string, FakeAgent>
  /** Agent volumes that still exist (kept after container removal). */
  volumes: Set<string>
  /** Calls with this method name. */
  callsTo(method: keyof InfraDriver): FakeCall[]
  /** Add/replace a branch, as if an agent pushed it. */
  setBranch(slug: string, name: string, b?: Partial<FakeBranch>): FakeBranch
  /** Next call to `method` rejects with this error (one-shot). */
  failNext(method: keyof InfraDriver, err?: Error): void
  /** Next mergeToMain returns exactly this (one-shot). */
  nextMergeResult(r: MergeResult): void
  setPing(ok: boolean): void
  /** Shells opened with openShell, in order. */
  shells: FakeShell[]
  /** Answers execInAgent (default: exit 0, empty output). */
  execHandler: FakeExecHandler
  /** Successful pushToRemote calls, in order. */
  pushes: FakePush[]
  /** Next pushToRemote returns exactly this (one-shot). */
  nextPushResult(r: PushResult): void
  reset(): void
}

const sha = () => randomBytes(20).toString('hex')

export function createFakeDriver(opts: FakeDriverOptions = {}): FakeDriver {
  let pingOk = opts.ping ?? true
  const failures = new Map<string, Error>()
  let mergeOverride: MergeResult | null = null
  let pushOverride: PushResult | null = null

  const self: FakeDriver = {
    calls: [],
    projects: new Map(),
    agents: new Map(),
    volumes: new Set(),
    shells: [],
    pushes: [],
    execHandler: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    nextPushResult(r) {
      pushOverride = r
    },

    callsTo(method) {
      return self.calls.filter((c) => c.method === method)
    },
    setBranch(slug, name, b = {}) {
      const p = mustProject(slug)
      const branch: FakeBranch = {
        sha: b.sha ?? sha(),
        aheadOfMain: b.aheadOfMain ?? 1,
        behindMain: b.behindMain ?? 0,
        diff: b.diff ?? `diff --git a/file b/file\n+change on ${name}\n`,
        conflict: b.conflict,
      }
      p.branches.set(assertBranch(name), branch)
      return branch
    },
    failNext(method, err = new Error(`fake ${method} failure`)) {
      failures.set(method, err)
    },
    nextMergeResult(r) {
      mergeOverride = r
    },
    setPing(ok) {
      pingOk = ok
    },
    reset() {
      self.calls.length = 0
      self.projects.clear()
      self.agents.clear()
      self.volumes.clear()
      self.shells.length = 0
      self.pushes.length = 0
      failures.clear()
      mergeOverride = null
      pushOverride = null
      pingOk = opts.ping ?? true
    },

    async ping() {
      record('ping', [])
      return pingOk
    },

    async ensureProject(slug, o = {}) {
      record('ensureProject', [slug, o])
      assertSlug(slug)
      if (self.projects.has(slug)) return
      self.projects.set(slug, {
        slug, repoUrl: o.repoUrl, projectName: o.projectName, mainSha: sha(),
        branches: new Map(),
      })
    },

    async removeProject(slug, o = {}) {
      record('removeProject', [slug, o])
      assertSlug(slug)
      for (const [id, a] of self.agents) {
        if (a.spec.projectSlug !== slug) continue
        self.agents.delete(id)
        if (o.purge) self.volumes.delete(names.agentVolume(id))
      }
      if (o.purge) {
        self.projects.delete(slug)
        removedProjects.delete(slug)
      } else {
        // Volumes (and so the repo) survive a non-purge removal; mark containers gone.
        const p = self.projects.get(slug)
        if (p) removedProjects.set(slug, p)
        self.projects.delete(slug)
      }
    },

    async startAgent(spec) {
      record('startAgent', [spec])
      assertSlug(spec.projectSlug)
      assertAgentId(spec.agentId)
      if (!self.projects.has(spec.projectSlug)) {
        throw new Error(`project network ${names.network(spec.projectSlug)} does not exist; call ensureProject first`)
      }
      self.agents.set(spec.agentId, { spec: { ...spec, env: { ...spec.env } }, running: true, volume: true })
      self.volumes.add(names.agentVolume(spec.agentId))
      return { name: names.agentContainer(spec.agentId) }
    },

    async stopAgent(agentId, o = {}) {
      record('stopAgent', [agentId, o])
      const a = self.agents.get(agentId)
      if (!a) return
      a.running = false
      if (o.remove) self.agents.delete(agentId)
    },

    async removeAgentVolume(agentId) {
      record('removeAgentVolume', [agentId])
      self.volumes.delete(names.agentVolume(agentId))
    },

    async agentStats(agentId) {
      record('agentStats', [agentId])
      const a = self.agents.get(agentId)
      if (!a) return null
      const memLimitMb = a.spec.memoryMb
      if (!a.running) return { running: false, cpuPct: 0, memMb: 0, memLimitMb }
      return { running: true, cpuPct: opts.stats?.cpuPct ?? 1.5, memMb: opts.stats?.memMb ?? 128, memLimitMb }
    },

    async listContainers() {
      record('listContainers', [])
      const out: ContainerInfo[] = []
      for (const slug of self.projects.keys()) {
        out.push({ name: names.gitContainer(slug), projectSlug: slug, kind: 'git', running: true })
      }
      for (const [id, a] of self.agents) {
        out.push({ name: names.agentContainer(id), agentId: id, projectSlug: a.spec.projectSlug, kind: 'agent', running: a.running })
      }
      return out
    },

    async listBranches(slug) {
      record('listBranches', [slug])
      const p = mustProject(slug)
      const res: BranchInfo[] = [{ name: 'main', sha: p.mainSha, aheadOfMain: 0, behindMain: 0 }]
      for (const [name, b] of p.branches) res.push({ name, sha: b.sha, aheadOfMain: b.aheadOfMain, behindMain: b.behindMain })
      return res
    },

    async diff(slug, branch) {
      record('diff', [slug, branch])
      assertBranch(branch)
      const b = mustProject(slug).branches.get(branch)
      if (!b) throw new Error(`diff ${branch} failed (exit 3): no such branch: ${branch}`)
      return b.diff
    },

    async mergeToMain(slug, branch, message) {
      record('mergeToMain', [slug, branch, message])
      assertBranch(branch)
      assertMessage(message)
      const p = mustProject(slug)
      if (mergeOverride) {
        const r = mergeOverride
        mergeOverride = null
        if (r.ok) p.mainSha = r.sha
        return r
      }
      const b = p.branches.get(branch)
      if (!b) return { ok: false, conflict: false, message: `no such branch: ${branch}` }
      if (b.conflict) return { ok: false, conflict: true, message: `merge conflict merging ${branch} into main` }
      if (b.aheadOfMain === 0) return { ok: true, sha: p.mainSha, message: `${branch} is already merged; main unchanged` }
      p.mainSha = sha()
      b.aheadOfMain = 0
      b.behindMain = 1
      for (const [n, other] of p.branches) if (n !== branch) other.behindMain += 1
      return { ok: true, sha: p.mainSha, message: `merged ${branch} into main` }
    },
    async pushToRemote(slug, o) {
      record('pushToRemote', [slug, { ...o, token: '***' }])
      assertPushUrl(o.url)
      assertLocalRef(o.srcRef)
      assertBranch(o.dstRef)
      const p = mustProject(slug)
      if (pushOverride) {
        const r = pushOverride
        pushOverride = null
        if (r.ok) self.pushes.push({ slug, ...o, sha: r.sha })
        return r
      }
      const branch = o.srcRef.slice('refs/heads/'.length)
      const sha = branch === 'main' ? p.mainSha : p.branches.get(branch)?.sha
      if (!sha) return { ok: false, reason: 'no_ref', message: `no such ref: ${o.srcRef}` }
      self.pushes.push({ slug, ...o, sha })
      return { ok: true, sha, message: `pushed ${o.srcRef} to ${o.dstRef}` }
    },

    async execInAgent(agentId, cmd, o = {}) {
      record('execInAgent', [agentId, cmd, o])
      assertAgentId(agentId)
      const a = self.agents.get(agentId)
      if (!a?.running) throw new Error(`container for ${agentId} is not running`)
      return self.execHandler(agentId, cmd)
    },

    async openShell(agentId, o) {
      record('openShell', [agentId, o])
      assertAgentId(agentId)
      if (!self.agents.get(agentId)?.running) throw new ContainerNotRunningError(`agent container for ${agentId} is not running`)
      const shell = {
        agentId, cols: o.cols, rows: o.rows, resizes: [], input: '', killed: false,
      } as unknown as FakeShell
      const stream = new Duplex({
        read() { /* pushed on write */ },
        write(chunk: Buffer, _enc, cb) {
          shell.input += chunk.toString('utf8')
          this.push(chunk)
          cb()
        },
      })
      shell.exit = () => { stream.push(null) }
      shell.handle = {
        stream,
        async resize(cols, rows) { shell.resizes.push([cols, rows]); shell.cols = cols; shell.rows = rows },
        async kill() {
          shell.killed = true
          stream.destroy()
        },
      }
      self.shells.push(shell)
      return shell.handle
    },
  }

  const removedProjects = new Map<string, FakeProject>()

  function record(method: keyof InfraDriver, args: unknown[]) {
    self.calls.push({ method, args })
    const err = failures.get(method)
    if (err) {
      failures.delete(method)
      throw err
    }
  }

  function mustProject(slug: string): FakeProject {
    assertSlug(slug)
    const p = self.projects.get(slug)
    if (!p) throw new Error(`no such project: ${slug}`)
    return p
  }

  // Re-ensuring a removed (not purged) project restores its repo, like the kept volume would.
  const ensure = self.ensureProject
  self.ensureProject = async (slug, o) => {
    const kept = removedProjects.get(slug)
    if (kept && !self.projects.has(slug)) {
      removedProjects.delete(slug)
      self.projects.set(slug, kept)
      self.calls.push({ method: 'ensureProject', args: [slug, o ?? {}] })
      return
    }
    return ensure(slug, o)
  }

  return self
}
