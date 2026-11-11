// Git workspace setup (docs/phase1.md "Runner behaviour" step 2).
//
//   no repo in the workspace  → git clone $COLONY_GIT_URL  (init + fetch if the dir isn't empty)
//   repo exists               → point origin at $COLONY_GIT_URL, fetch (best effort)
//   then check out $COLONY_BRANCH:
//     local branch exists      → check it out (and track origin/<branch> if that exists)
//     only origin/<branch>     → create it tracking the remote
//     neither                  → create it from origin/main (or as an unborn branch in an empty repo)

import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from './log'

export interface WorkspaceInfo {
  branch: string
  headSha?: string
}

export class GitError extends Error {
  constructor(readonly args: string[], readonly code: number | null, readonly stderr: string) {
    super(`git ${args.join(' ')} failed (exit ${code ?? '?'}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`)
    this.name = 'GitError'
  }
}

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const errCode = (err as { code?: unknown } | null)?.code
      const code = err ? (typeof errCode === 'number' ? errCode : -1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err ? err.message : '') })
    })
  })
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args)
  if (r.code !== 0) throw new GitError(args, r.code, r.stderr)
  return r.stdout.trim()
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0
}

export async function setupWorkspace(opts: { dir: string; gitUrl: string; branch: string; log: Logger }): Promise<WorkspaceInfo> {
  const { dir, gitUrl, branch, log } = opts
  mkdirSync(dir, { recursive: true })

  if (!existsSync(join(dir, '.git'))) {
    if (readdirSync(dir).length === 0) {
      log.info(`cloning ${gitUrl} into ${dir}`)
      await gitOk(dir, ['clone', gitUrl, '.'])
    } else {
      log.info(`${dir} is not empty and has no repo; initialising and fetching ${gitUrl}`)
      await gitOk(dir, ['init'])
      await gitOk(dir, ['remote', 'add', 'origin', gitUrl])
      await gitOk(dir, ['fetch', '--prune', 'origin'])
    }
  } else {
    const current = await git(dir, ['remote', 'get-url', 'origin'])
    if (current.code !== 0) await gitOk(dir, ['remote', 'add', 'origin', gitUrl])
    else if (current.stdout.trim() !== gitUrl) await gitOk(dir, ['remote', 'set-url', 'origin', gitUrl])
    const f = await git(dir, ['fetch', '--prune', 'origin'])
    if (f.code !== 0) log.warn('git fetch failed; continuing with the local state', f.stderr.trim().slice(-300))
  }

  const remoteRef = `refs/remotes/origin/${branch}`
  const hasLocal = await refExists(dir, `refs/heads/${branch}`)
  const hasRemote = await refExists(dir, remoteRef)

  if (hasLocal) {
    await gitOk(dir, ['checkout', branch])
    if (hasRemote) {
      const upstream = await git(dir, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])
      if (upstream.code !== 0) await gitOk(dir, ['branch', `--set-upstream-to=origin/${branch}`, branch])
    }
  } else if (hasRemote) {
    await gitOk(dir, ['checkout', '-b', branch, '--track', `origin/${branch}`])
  } else if (await refExists(dir, 'refs/remotes/origin/main')) {
    await gitOk(dir, ['checkout', '--no-track', '-b', branch, 'origin/main'])
  } else {
    // Empty repository (no main yet): start the branch unborn; the first commit creates it.
    log.warn('origin has no main branch yet; starting an unborn branch')
    await gitOk(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  }

  excludeColonyDir(dir)

  const head = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const headSha = head.code === 0 ? head.stdout.trim() : undefined
  log.info(`workspace ready on ${branch}${headSha ? ` @ ${headSha.slice(0, 12)}` : ' (no commits)'}`)
  return { branch, ...(headSha ? { headSha } : {}) }
}

/** Colony keeps the Claude session under /workspace/.colony (CLAUDE_CONFIG_DIR, docs/phase6.md) so
 *  it survives container recreation. Keep it out of git with a local-only exclude. */
export function excludeColonyDir(dir: string) {
  const info = join(dir, '.git', 'info')
  const file = join(info, 'exclude')
  try {
    mkdirSync(info, { recursive: true })
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (!cur.split(/\r?\n/).some((l) => l.trim() === '.colony/' || l.trim() === '/.colony/')) {
      const sep = cur && !cur.endsWith('\n') ? '\n' : ''
      appendFileSync(file, `${sep}# Colony session data (never committed)\n/.colony/\n`)
    }
  } catch { /* best effort */ }
}

/** Retry `setupWorkspace` (the project's git server may still be starting). */
export async function setupWorkspaceWithRetry(
  opts: Parameters<typeof setupWorkspace>[0] & { attempts?: number; baseDelayMs?: number; onRetry?: (err: Error, attempt: number) => void },
): Promise<WorkspaceInfo> {
  const attempts = opts.attempts ?? 6
  const base = opts.baseDelayMs ?? 1000
  for (let i = 1; ; i++) {
    try {
      return await setupWorkspace(opts)
    } catch (e) {
      if (i >= attempts) throw e
      opts.onRetry?.(e as Error, i)
      await new Promise((r) => setTimeout(r, Math.min(15_000, base * 2 ** (i - 1))))
    }
  }
}
