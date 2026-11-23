// Git server side of the Docker driver: the per-project network, volume and git daemon, plus
// every operation that runs git inside that container (branches, diff, merge, checkpoints,
// revert, push to a remote). Scripts live in ../git-scripts.
import { execIn } from '../exec'
import {
  DIFF, ENSURE_REPO, LIST_BRANCHES, MERGE, MERGE_EXIT, PRE_RECEIVE_HOOK, PUSH_EXIT, PUSH_REMOTE,
  BRANCH_LOG, COUNT_COMMITS, LIST_REFS, RESET_BRANCH, RESET_EXIT, SET_REF,
} from '../git-scripts'
import {
  RefRejectedError,
  type BranchInfo, type CommitInfo, type InfraDriver, type MergeResult, type PushResult,
} from '../types'
import {
  InfraValidationError, assertBranch, assertColonyRef, assertLocalRef, assertMessage,
  assertPushUrl, assertRepoUrl, assertSha, assertSlug, names,
} from '../validate'
import { GIT_DAEMON_CMD, MB, ignoreMissing, sh, statusCode, type DockerCtx } from './common'

type GitMethods = Pick<InfraDriver,
  'ensureProject' | 'removeProject' | 'listBranches' | 'diff' | 'mergeToMain' | 'branchLog' | 'countCommits' | 'listRefs' |
  'setRef' | 'resetBranch' | 'pushToRemote'>

export function gitServerMethods(ctx: DockerCtx): GitMethods {
  const { docker, gitImage, exec, gitExec, mustOk, ensureVolume } = ctx

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

  return {
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

    async listBranches(slug): Promise<BranchInfo[]> {
      assertSlug(slug)
      const r = await mustOk(await gitExec(slug, sh(LIST_BRANCHES)), 'list branches')
      return parseBranchList(r.stdout)
    },

    async diff(slug, branch, base) {
      assertSlug(slug)
      await checkBranch(slug, branch)
      if (base) await checkBranch(slug, base)
      const r = await mustOk(await gitExec(slug, base ? sh(DIFF, branch, base) : sh(DIFF, branch)), `diff ${branch}`)
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

    async countCommits(slug, from, to) {
      assertSlug(slug)
      assertSha(from)
      if (to !== 'main') assertSha(to)
      const r = await gitExec(slug, sh(COUNT_COMMITS, from, to === 'main' ? 'refs/heads/main' : to))
      if (r.exitCode === 3) return null
      const out = await mustOk(r, 'count commits')
      const n = Number(out.stdout.trim().split(/\r?\n/).pop())
      return Number.isInteger(n) && n >= 0 ? n : null
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

    async pushToRemote(slug, o): Promise<PushResult> {
      assertSlug(slug)
      assertPushUrl(o.url)
      assertLocalRef(o.srcRef)
      await checkBranch(slug, o.dstRef)
      if (typeof o.token !== 'string' || !o.token || /[\s\0]/.test(o.token)) throw new InfraValidationError('invalid token')
      // The token goes in the exec environment only, never in Cmd (which `docker inspect` shows).
      // The git server is on the project's bridge network, which has outbound access.
      const r = await execIn(docker, names.gitContainer(slug), sh(PUSH_REMOTE, o.url, o.srcRef, o.dstRef), {
        user: 'node', env: [`COLONY_GIT_TOKEN=${o.token}`], timeoutMs: 300_000,
      })
      const scrub = (t: string) => t.split(o.token).join('***').replace(/(Authorization:\s*\w+\s+)\S+/gi, '$1***')
      const detail = scrub((r.stderr.trim() || r.stdout.trim()).slice(-2000))
      switch (r.exitCode) {
        case 0:
          return { ok: true, sha: r.stdout.trim().split('\n').pop()!, message: `pushed ${o.srcRef} to ${o.dstRef}` }
        case PUSH_EXIT.rejected:
          return { ok: false, reason: 'non_fast_forward', message: `the remote rejected the push (not a fast-forward):\n${detail}` }
        case PUSH_EXIT.noRef:
          return { ok: false, reason: 'no_ref', message: `no such ref: ${o.srcRef}` }
        default:
          return { ok: false, reason: 'failed', message: `git push failed (exit ${r.exitCode}): ${detail}` }
      }
    },
  }
}

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

/** `<name> <sha> <behind> <ahead>` lines from LIST_BRANCHES. */
export function parseBranchList(out: string): BranchInfo[] {
  const res: BranchInfo[] = []
  for (const line of out.split('\n')) {
    const p = line.trim().split(/\s+/)
    if (p.length !== 4) continue
    res.push({ name: p[0], sha: p[1], behindMain: Number(p[2]) || 0, aheadOfMain: Number(p[3]) || 0 })
  }
  return res
}
