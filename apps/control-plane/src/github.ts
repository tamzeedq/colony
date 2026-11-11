// Publishing merged work to GitHub (docs/phase6.md "GitHub").
//
// The commander's fine-grained token is stored AES-GCM encrypted with the master key (the
// SecretBox from providers.ts, kv `github:token`). It is only decrypted for an explicit
// Test or Publish click. It is never logged, never returned (responses carry
// GithubTokenStatus), never given to an agent, and every message that could echo it goes
// through redact(). The push itself runs in the project's git container
// (InfraDriver.pushToRemote) with the token in the exec environment only.

import { join } from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { GithubConfig, GithubPublish, GithubTokenStatus, MergeRequest, Project } from '@colony/shared'
import type { Config } from './config'
import { badRequest, conflict, HttpError, notFound } from './errors'
import type { InfraDriver } from './infra/types'
import { isGithubRepo, isValidBranchName } from './infra/validate'
import { SecretBox, type FetchLike } from './providers'
import { newId, nowIso, type ProjectRecord, type Store } from './store'

const API = 'https://api.github.com'
const TIMEOUT_MS = 15_000
const KV_TOKEN = 'github:token'
const AAD = 'github'
const publishedKey = (projectId: string) => `github_published:${projectId}`

interface StoredToken {
  /** v1:<base64(iv | tag | ciphertext)> */
  token?: string
  login?: string
  status?: GithubTokenStatus['status']
  statusDetail?: string
  testedAt?: string
}

export interface PublishResult {
  url?: string
  branch: string
  sha: string
  mode: 'pr' | 'push'
  /** Merge requests listed in this publish. */
  mergeRequests: number
}

// ── pure helpers ─────────────────────────────────────────────────────────────

/** Remove a token (and the Basic header built from it) plus anything token-shaped from text
 *  that may be shown, stored or logged. */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = String(text ?? '')
  for (const s of secrets) {
    if (!s || s.length < 4) continue
    out = out.split(s).join('***')
    out = out.split(Buffer.from(`x-access-token:${s}`).toString('base64')).join('***')
    out = out.split(encodeURIComponent(s)).join('***')
  }
  return out
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '***')
    .replace(/(authorization:\s*(?:basic|bearer|token)\s+)\S+/gi, '$1***')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
}

/** `owner/name` from a GitHub URL (https, ssh:// or scp-like git@) or an `owner/name` string. */
export function githubRepoFromUrl(input: string | undefined): string | undefined {
  if (!input || typeof input !== 'string') return undefined
  const s = input.trim()
  const m =
    /^(?:https?:\/\/(?:www\.)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(s)
  const repo = m ? `${m[1]}/${m[2]}` : /^[^/\s:]+\/[^/\s:]+$/.test(s) ? s.replace(/\.git$/i, '') : undefined
  return repo && isGithubRepo(repo) ? repo : undefined
}

/** Default config for a project imported from a GitHub URL. */
export function githubConfigFromRepoUrl(repoUrl: string | undefined): GithubConfig | undefined {
  const repo = githubRepoFromUrl(repoUrl)
  return repo ? { repo, base: 'main', mode: 'pr' } : undefined
}

/** colony/<yyyymmdd-hhmm> in UTC. */
export function publishBranchName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `colony/${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
}

// ── service ──────────────────────────────────────────────────────────────────

export class GithubService {
  private box: SecretBox
  private fetch: FetchLike
  private busy = new Set<string>()

  constructor(private store: Store, config: Config, private infra: InfraDriver, fetchImpl?: FetchLike) {
    this.box = new SecretBox(join(config.dataDir, 'master.key'))
    this.fetch = fetchImpl ?? ((url, init) => fetch(url, init))
  }

  private stored(): StoredToken { return this.store.db.kvGet<StoredToken>(KV_TOKEN) ?? {} }
  private save(s: StoredToken) { this.store.db.kvSet(KV_TOKEN, s) }

  status(): GithubTokenStatus {
    const s = this.stored()
    if (!s.token) return { configured: false, status: 'missing' }
    return {
      configured: true,
      status: s.status ?? 'untested',
      ...(s.login ? { login: s.login } : {}),
      ...(s.testedAt ? { testedAt: s.testedAt } : {}),
      ...(s.statusDetail ? { statusDetail: s.statusDetail } : {}),
    }
  }

  setToken(token: string): GithubTokenStatus {
    this.save({ token: this.box.encrypt(token, AAD), status: 'untested' })
    return this.status()
  }

  deleteToken(): GithubTokenStatus {
    this.store.db.kvSet(KV_TOKEN, null)
    return this.status()
  }

  private decrypt(): string {
    const s = this.stored()
    if (!s.token) throw new HttpError(400, 'no_token', 'no GitHub token: add one in Settings → GitHub')
    try {
      return this.box.decrypt(s.token, AAD)
    } catch {
      throw new HttpError(400, 'no_token', 'the stored GitHub token cannot be decrypted; set it again in Settings → GitHub')
    }
  }

  /** GET /user with the stored token. Upstream failures become the status, not an error. */
  async test(): Promise<GithubTokenStatus> {
    const s = this.stored()
    if (!s.token) return this.status()
    let token: string
    try {
      token = this.decrypt()
    } catch (e) {
      this.save({ ...s, status: 'error', statusDetail: (e as Error).message, testedAt: nowIso() })
      return this.status()
    }
    const r = await this.api(token, 'GET', '/user')
    const login = r.ok && typeof (r.json as { login?: unknown })?.login === 'string' ? String((r.json as { login: string }).login) : undefined
    if (r.ok) this.save({ token: s.token, status: 'connected', ...(login ? { login } : {}), testedAt: nowIso() })
    else this.save({ token: s.token, status: 'error', statusDetail: r.error, testedAt: nowIso() })
    return this.status()
  }

  // ── per-project config ──

  private rec(projectId: string): ProjectRecord {
    const rec = this.store.projects.get(projectId)
    if (!rec) throw notFound('project')
    return rec
  }

  configure(projectId: string, input: { repo?: string | null; base?: string; mode?: 'pr' | 'push' }): Project {
    const rec = this.rec(projectId)
    const cur = rec.project.github
    if (input.repo === null || input.repo === '') {
      const { github: _g, ...rest } = rec.project
      rec.project = rest as Project
    } else {
      const repo = input.repo !== undefined ? githubRepoFromUrl(input.repo) : cur?.repo
      if (input.repo !== undefined && !repo) throw badRequest("'repo' must be 'owner/name' (or a github.com URL)")
      if (!repo) throw badRequest("'repo' is required")
      const next: GithubConfig = {
        repo,
        base: input.base ?? cur?.base ?? 'main',
        mode: input.mode ?? cur?.mode ?? 'pr',
        ...(cur?.lastPublish && cur.repo === repo ? { lastPublish: cur.lastPublish } : {}),
      }
      rec.project = { ...rec.project, github: next }
    }
    this.store.saveProject(rec)
    this.store.broadcastSnapshot()
    return this.store.toProject(rec)
  }

  // ── publish ──

  /** Merged merge requests of the project not yet included in a publish. */
  unpublished(projectId: string): MergeRequest[] {
    const done = new Set(this.store.db.kvGet<string[]>(publishedKey(projectId)) ?? [])
    return [...this.store.mergeRequests.values()].filter((m) => m.projectId === projectId && m.status === 'merged' && !done.has(m.id))
  }

  async publish(projectId: string): Promise<PublishResult> {
    const rec = this.rec(projectId)
    const cfg = rec.project.github
    if (!cfg?.repo) throw new HttpError(400, 'no_repo', 'no GitHub repo set for this project: set owner/name in the Infra panel')
    if (!this.stored().token) throw new HttpError(400, 'no_token', 'no GitHub token: add one in Settings → GitHub')
    if (!this.infra.pushToRemote) throw new HttpError(501, 'not_supported', 'this infra driver cannot push to GitHub')
    if (this.busy.has(projectId)) throw conflict('a publish is already running for this project')
    this.busy.add(projectId)
    let token: string | undefined
    try {
      token = this.decrypt()
      const result = await this.doPublish(rec, cfg, token)
      this.record(projectId, `Published to GitHub: ${result.url ?? `${cfg.repo}@${result.branch}`} (${result.sha.slice(0, 7)})`)
      return result
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(502, 'github_error', `publish failed: ${(e as Error).message}`)
      const safe = new HttpError(err.statusCode, err.code, redact(err.message, [token]))
      if (err.code !== 'no_token') this.record(projectId, `GitHub publish failed: ${safe.message.split('\n')[0].slice(0, 300)}`)
      throw safe
    } finally {
      this.busy.delete(projectId)
    }
  }

  private async doPublish(rec: ProjectRecord, cfg: GithubConfig, token: string): Promise<PublishResult> {
    const url = `https://github.com/${cfg.repo}.git`
    const mrs = this.unpublished(rec.project.id)
    const branch = cfg.mode === 'push' ? cfg.base : publishBranchName()
    let push
    try {
      push = await this.infra.pushToRemote!(rec.slug, { url, srcRef: 'refs/heads/main', dstRef: branch, token })
    } catch (e) {
      const err = e as Error
      if (err.name === 'InfraValidationError') throw badRequest(redact(err.message, [token]))
      throw new HttpError(502, 'push_failed', `git push failed: ${redact(err.message, [token])}`)
    }
    if (!push.ok) {
      const msg = redact(push.message, [token])
      if (push.reason === 'non_fast_forward') {
        throw new HttpError(409, 'non_fast_forward', cfg.mode === 'push'
          ? `${cfg.repo}:${cfg.base} has commits that Colony's main does not, so a fast-forward push is not possible. Use PR mode, or bring those commits into Colony first.\n${msg}`
          : `GitHub rejected the push to ${branch} (not a fast-forward).\n${msg}`)
      }
      throw new HttpError(502, 'push_failed', msg)
    }

    let prUrl: string | undefined
    if (cfg.mode === 'pr') {
      const n = mrs.length
      const title = n ? `Colony: ${n} merged quest${n === 1 ? '' : 's'}` : `Colony: publish main (${push.sha.slice(0, 7)})`
      const r = await this.api(token, 'POST', `/repos/${cfg.repo}/pulls`, {
        title, head: branch, base: cfg.base, body: this.prBody(mrs, push.sha), maintainer_can_modify: true,
      })
      if (!r.ok) throw new HttpError(502, 'github_error', `pushed ${branch}, but opening the pull request failed: ${r.error}`)
      const html = (r.json as { html_url?: unknown })?.html_url
      prUrl = typeof html === 'string' && /^https:\/\//.test(html) ? html : undefined
    }

    const last: GithubPublish = { at: nowIso(), ...(prUrl ? { url: prUrl } : {}), branch, sha: push.sha, mode: cfg.mode }
    const fresh = this.store.projects.get(rec.project.id)
    if (fresh?.project.github) {
      fresh.project = { ...fresh.project, github: { ...fresh.project.github, lastPublish: last } }
      this.store.saveProject(fresh)
    }
    const done = this.store.db.kvGet<string[]>(publishedKey(rec.project.id)) ?? []
    this.store.db.kvSet(publishedKey(rec.project.id), [...done, ...mrs.map((m) => m.id)].slice(-1000))
    this.store.broadcastSnapshot()
    return { ...(prUrl ? { url: prUrl } : {}), branch, sha: push.sha, mode: cfg.mode, mergeRequests: mrs.length }
  }

  private prBody(mrs: MergeRequest[], sha: string): string {
    const lines = ['Merged in Colony since the last publish (each approved by the commander):', '']
    if (!mrs.length) lines.push('- (no merge requests recorded since the last publish)')
    for (const m of mrs) {
      const q = m.questId ? this.store.quests.get(m.questId) : undefined
      const label = q ? `Quest "${q.title}"` : 'Merge'
      const summary = m.summary ? ` · ${m.summary.replace(/\s+/g, ' ').slice(0, 300)}` : ''
      lines.push(`- ${label} (\`${m.branch}\`${m.approvedAt ? `, approved ${m.approvedAt.slice(0, 10)}` : ''})${summary}`)
    }
    lines.push('', `Colony main at ${sha}.`)
    return lines.join('\n')
  }

  private record(projectId: string, text: string) {
    this.store.addEvent({ id: newId('ev'), at: nowIso(), agentId: 'you', projectId, kind: 'status', text })
  }

  /** One GitHub REST call. Never throws: failures come back as a redacted `error`. */
  private async api(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: boolean; status: number; json?: unknown; error: string }> {
    try {
      const res = await this.fetch(API + path, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'colony',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // Never follow a redirect with the token attached.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      let json: unknown
      try { json = JSON.parse((await res.text()).slice(0, 200_000)) } catch { /* not JSON */ }
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, json, error: '' }
      const j = json as { message?: unknown; errors?: { message?: unknown }[] } | undefined
      const parts = [typeof j?.message === 'string' ? j.message : res.statusText]
      for (const e of j?.errors ?? []) if (typeof e?.message === 'string') parts.push(e.message)
      const detail = parts.filter(Boolean).join(': ')
      return { ok: false, status: res.status, json, error: redact(`HTTP ${res.status}${detail ? ` ${detail}` : ''}`, [token]).slice(0, 300) }
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } }
      const why = err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `timed out after ${TIMEOUT_MS / 1000} s`
        : `network error: ${err.cause?.code ?? err.cause?.message ?? err.message}`
      return { ok: false, status: 0, error: redact(why, [token]).slice(0, 300) }
    }
  }
}

// ── routes ───────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
function bodyOf(req: FastifyRequest): Obj {
  const b = req.body
  if (b === undefined || b === null || b === '') return {}
  if (typeof b !== 'object' || Array.isArray(b)) throw badRequest('body must be a JSON object')
  return b as Obj
}

export function registerGithubRoutes(app: FastifyInstance, d: { github: GithubService; store: Store }) {
  const { github, store } = d
  const pid = (req: FastifyRequest) => String((req.params as Obj).id ?? '')

  // The token is write-only: every route answers with GithubTokenStatus.
  app.get('/api/github', async () => github.status())
  app.put('/api/github/token', async (req) => {
    const b = bodyOf(req)
    for (const k of Object.keys(b)) if (k !== 'token') throw badRequest(`unknown field '${k}'`)
    const t = typeof b.token === 'string' ? b.token.trim() : ''
    if (!t) throw badRequest("'token' must be a non-empty string (use DELETE /api/github/token to remove it)")
    if (t.length > 1000 || /[\s\x00-\x1f\x7f]/.test(t)) throw badRequest("'token' must be at most 1000 characters with no whitespace or control characters")
    return github.setToken(t)
  })
  app.delete('/api/github/token', async () => github.deleteToken())
  app.post('/api/github/test', async () => github.test())

  app.patch('/api/projects/:id/github', async (req) => {
    const b = bodyOf(req)
    for (const k of Object.keys(b)) if (!['repo', 'base', 'mode'].includes(k)) throw badRequest(`unknown field '${k}'`)
    let repo: string | null | undefined
    if (b.repo === null) repo = null
    else if (b.repo !== undefined) {
      if (typeof b.repo !== 'string' || b.repo.length > 300) throw badRequest("'repo' must be a string")
      repo = b.repo.trim()
    }
    let base: string | undefined
    if (b.base !== undefined) {
      if (typeof b.base !== 'string' || !isValidBranchName(b.base.trim())) throw badRequest("'base' must be a valid branch name")
      base = b.base.trim()
    }
    if (b.mode !== undefined && b.mode !== 'pr' && b.mode !== 'push') throw badRequest("'mode' must be 'pr' or 'push'")
    if (repo === undefined && base === undefined && b.mode === undefined) throw badRequest("send 'repo', 'base' and/or 'mode'")
    return github.configure(pid(req), { repo, base, mode: b.mode as 'pr' | 'push' | undefined })
  })

  app.post('/api/projects/:id/github/publish', async (req) => {
    if (!store.projects.has(pid(req))) throw notFound('project')
    return github.publish(pid(req))
  })
}
