// Phase 6 "GitHub" (docs/phase6.md): encrypted token, Test, per-project config, publish in
// PR and push modes, refusals, and the token never leaking. Fake InfraDriver + fake fetch.

import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GithubTokenStatus, MergeRequest, Project } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT } from './config'
import { githubRepoFromUrl, publishBranchName, redact } from './github'
import { createFakeDriver, type FakeDriver } from './infra/fake'
import { isGithubRepo } from './infra/validate'
import type { FetchLike } from './providers'

const ADMIN = 'admin-secret-for-tests'
const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234'

interface FetchCall { url: string; init: RequestInit }
interface Ctx {
  app: ColonyApp
  infra: FakeDriver
  base: string
  dir: string
  calls: FetchCall[]
  /** Answers GitHub API calls. */
  respond: (call: FetchCall) => Promise<Response>
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'colony-gh-'))
  const infra = createFakeDriver()
  const config = loadConfig({}, {
    dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
    oauthToken: 'sk-ant-oat-test-token-not-real', adminToken: ADMIN, port: 0, bind: '127.0.0.1',
  })
  const ctx = { infra, dir, calls: [] as FetchCall[], respond: async () => json(200, {}) } as unknown as Ctx
  const fakeFetch: FetchLike = async (url, init) => {
    const call = { url, init }
    ctx.calls.push(call)
    return ctx.respond(call)
  }
  ctx.app = await createApp({ config, infra, poll: false, quiet: true, fetch: fakeFetch })
  const port = await ctx.app.start(0, '127.0.0.1')
  ctx.base = `http://127.0.0.1:${port}`
  return ctx
}

async function api<T = any>(c: Ctx, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { authorization: `Bearer ${ADMIN}` }
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(c.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* plain */ }
  return { status: res.status, body: parsed as T, text }
}

async function project(c: Ctx, body: Record<string, unknown> = {}) {
  const r = await api<Project>(c, 'POST', '/api/projects', { name: 'Readable', goal: 'Ship', ...body })
  assert.equal(r.status, 201, r.text)
  return r.body
}

/** Open, approve and merge an MR for a fresh branch (so there is something to publish). */
async function mergedMr(c: Ctx, p: Project, branch: string): Promise<MergeRequest> {
  const slug = c.app.store.projects.get(p.id)!.slug
  c.infra.setBranch(slug, branch)
  const mr = (await api<MergeRequest>(c, 'POST', '/api/merge-requests', { projectId: p.id, branch })).body
  const ap = await api(c, 'POST', `/api/merge-requests/${mr.id}/approve`)
  assert.equal(ap.status, 200, ap.text)
  return mr
}

/** Everything that could carry the token to a viewer, a log or disk-in-the-clear. */
function assertNoToken(c: Ctx, ...extra: string[]) {
  const s = c.app.store
  const haystack = [
    JSON.stringify(s.snapshot()),
    JSON.stringify(s.recentEvents(1000)),
    JSON.stringify([...s.alerts.values()]),
    JSON.stringify(c.infra.calls),
    ...extra,
  ].join('\n')
  assert.ok(!haystack.includes(TOKEN), 'token leaked')
  assert.ok(!haystack.includes(Buffer.from(`x-access-token:${TOKEN}`).toString('base64')), 'auth header leaked')
}

describe('github helpers', () => {
  test('redact removes the token, its Basic header and token-shaped strings', () => {
    const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
    const out = redact(`fatal: ${TOKEN} header Authorization: Basic ${b64} url https://x-access-token:${TOKEN}@github.com/a/b ghp_abcdefghijklmnopqrstuvwxyz0123`, [TOKEN])
    assert.ok(!out.includes(TOKEN))
    assert.ok(!out.includes(b64))
    assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'))
    assert.match(out, /Authorization: Basic \*\*\*/)
    assert.equal(redact('nothing secret here', [TOKEN]), 'nothing secret here')
    assert.equal(redact('ok', [undefined, '']), 'ok')
  })

  test('repo parsing and validation', () => {
    assert.equal(githubRepoFromUrl('https://github.com/acme/readable.git'), 'acme/readable')
    assert.equal(githubRepoFromUrl('https://github.com/acme/readable'), 'acme/readable')
    assert.equal(githubRepoFromUrl('git@github.com:acme/read.able.git'), 'acme/read.able')
    assert.equal(githubRepoFromUrl('ssh://git@github.com/acme/readable.git'), 'acme/readable')
    assert.equal(githubRepoFromUrl('acme/readable'), 'acme/readable')
    assert.equal(githubRepoFromUrl('https://gitlab.com/acme/readable.git'), undefined)
    assert.equal(githubRepoFromUrl('acme/../x'), undefined)
    assert.ok(isGithubRepo('a-b/c_d.e'))
    for (const bad of ['-a/b', 'a--b/c', 'a/b/c', 'a/', '/b', 'a b/c', 'a/..', 'a/$(x)']) assert.ok(!isGithubRepo(bad), bad)
    assert.equal(publishBranchName(new Date(Date.UTC(2026, 10, 10, 9, 5))), 'colony/20261110-0905')
  })
})

describe('github token', () => {
  let c: Ctx
  beforeEach(async () => { c = await setup() })
  afterEach(async () => { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }) })

  test('stored encrypted, never returned', async () => {
    assert.deepEqual((await api(c, 'GET', '/api/github')).body, { configured: false, status: 'missing' })
    assert.equal((await api(c, 'PUT', '/api/github/token', { token: '' })).status, 400)
    assert.equal((await api(c, 'PUT', '/api/github/token', { token: 'has space' })).status, 400)
    assert.equal((await api(c, 'PUT', '/api/github/token', { token: TOKEN, extra: 1 })).status, 400)
    const put = await api<GithubTokenStatus>(c, 'PUT', '/api/github/token', { token: TOKEN })
    assert.equal(put.status, 200)
    assert.deepEqual(put.body, { configured: true, status: 'untested' })
    assert.ok(!put.text.includes(TOKEN))
    const kv = c.app.db.kvGet<{ token: string }>('github:token')!
    assert.match(kv.token, /^v1:/)
    assert.ok(!JSON.stringify(kv).includes(TOKEN))
    assert.ok(!readFileSync(join(c.dir, 'colony.db')).includes(TOKEN), 'token in the DB file in the clear')
    const get = await api(c, 'GET', '/api/github')
    assert.ok(!get.text.includes(TOKEN))
    assertNoToken(c, put.text, get.text)
    const del = await api<GithubTokenStatus>(c, 'DELETE', '/api/github/token')
    assert.deepEqual(del.body, { configured: false, status: 'missing' })
  })

  test('Test calls GET /user and shows the login; failures become the status', async () => {
    assert.equal((await api<GithubTokenStatus>(c, 'POST', '/api/github/test')).body.status, 'missing')
    assert.equal(c.calls.length, 0)
    await api(c, 'PUT', '/api/github/token', { token: TOKEN })
    c.respond = async () => json(200, { login: 'octo-commander', id: 1 })
    const ok = await api<GithubTokenStatus>(c, 'POST', '/api/github/test')
    assert.equal(ok.status, 200)
    assert.equal(ok.body.status, 'connected')
    assert.equal(ok.body.login, 'octo-commander')
    assert.ok(ok.body.testedAt)
    const call = c.calls.at(-1)!
    assert.equal(call.url, 'https://api.github.com/user')
    assert.equal((call.init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`)
    assert.equal(call.init.redirect, 'manual')

    c.respond = async () => json(401, { message: `Bad credentials for ${TOKEN}` })
    const bad = await api<GithubTokenStatus>(c, 'POST', '/api/github/test')
    assert.equal(bad.body.status, 'error')
    assert.match(bad.body.statusDetail!, /HTTP 401 Bad credentials/)
    assert.equal(bad.body.login, undefined)
    assertNoToken(c, ok.text, bad.text)

    c.respond = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) }
    assert.match((await api<GithubTokenStatus>(c, 'POST', '/api/github/test')).body.statusDetail!, /ENOTFOUND/)
  })
})

describe('github publish', () => {
  let c: Ctx
  beforeEach(async () => { c = await setup() })
  afterEach(async () => { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }) })

  test('project config: pre-filled from a GitHub URL, PATCH validates', async () => {
    const imported = await project(c, { name: 'Imported', repoUrl: 'https://github.com/acme/readable.git' })
    assert.deepEqual(imported.github, { repo: 'acme/readable', base: 'main', mode: 'pr' })
    const other = await project(c, { name: 'Elsewhere', repoUrl: 'https://gitlab.com/acme/x.git' })
    assert.equal(other.github, undefined)

    assert.equal((await api(c, 'PATCH', `/api/projects/${other.id}/github`, { base: 'main' })).status, 400) // no repo yet
    assert.equal((await api(c, 'PATCH', `/api/projects/${other.id}/github`, { repo: 'not a repo' })).status, 400)
    assert.equal((await api(c, 'PATCH', `/api/projects/${other.id}/github`, { repo: 'a/b', base: 'bad..branch' })).status, 400)
    assert.equal((await api(c, 'PATCH', `/api/projects/${other.id}/github`, { repo: 'a/b', mode: 'force' })).status, 400)
    assert.equal((await api(c, 'PATCH', `/api/projects/${other.id}/github`, { repo: 'a/b', token: 'x' })).status, 400)
    assert.equal((await api(c, 'PATCH', '/api/projects/nope/github', { repo: 'a/b' })).status, 404)
    const ok = await api<Project>(c, 'PATCH', `/api/projects/${other.id}/github`, { repo: 'git@github.com:acme/x.git', base: 'develop', mode: 'push' })
    assert.equal(ok.status, 200, ok.text)
    assert.deepEqual(ok.body.github, { repo: 'acme/x', base: 'develop', mode: 'push' })
    const snap = (await api(c, 'GET', '/api/snapshot')).body
    assert.deepEqual(snap.projects.find((p: Project) => p.id === other.id).github, { repo: 'acme/x', base: 'develop', mode: 'push' })
    const cleared = await api<Project>(c, 'PATCH', `/api/projects/${other.id}/github`, { repo: null })
    assert.equal(cleared.body.github, undefined)
  })

  test('refusals: no repo, no token', async () => {
    const p = await project(c)
    let r = await api(c, 'POST', `/api/projects/${p.id}/github/publish`)
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'no_repo')
    await api(c, 'PATCH', `/api/projects/${p.id}/github`, { repo: 'acme/readable' })
    r = await api(c, 'POST', `/api/projects/${p.id}/github/publish`)
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'no_token')
    assert.equal(c.infra.callsTo('pushToRemote').length, 0)
    assert.equal(c.calls.length, 0)
    assert.equal((await api(c, 'POST', '/api/projects/nope/github/publish')).status, 404)
  })

  test('pr mode: pushes main to colony/<stamp> and opens a PR listing the merged quests', async () => {
    const p = await project(c, { repoUrl: 'https://github.com/acme/readable.git' })
    await api(c, 'PUT', '/api/github/token', { token: TOKEN })
    const q = await api(c, 'POST', `/api/projects/${p.id}/quests`, { title: 'Streak counter' })
    const slug = c.app.store.projects.get(p.id)!.slug
    c.infra.setBranch(slug, 'agent/streaks')
    const mr1 = (await api<MergeRequest>(c, 'POST', '/api/merge-requests', { projectId: p.id, branch: 'agent/streaks' })).body
    c.app.store.saveMergeRequest({ ...c.app.store.mergeRequests.get(mr1.id)!, questId: q.body.id, summary: 'Adds the streak counter' })
    await api(c, 'POST', `/api/merge-requests/${mr1.id}/approve`)
    await mergedMr(c, p, 'agent/docs')
    // Not merged: must not be listed.
    c.infra.setBranch(slug, 'agent/wip')
    await api(c, 'POST', '/api/merge-requests', { projectId: p.id, branch: 'agent/wip' })

    c.respond = async ({ url, init }) => {
      assert.equal(url, 'https://api.github.com/repos/acme/readable/pulls')
      assert.equal(init.method, 'POST')
      return json(201, { number: 7, html_url: 'https://github.com/acme/readable/pull/7' })
    }
    const r = await api(c, 'POST', `/api/projects/${p.id}/github/publish`)
    assert.equal(r.status, 200, r.text)
    const mainSha = c.infra.projects.get(slug)!.mainSha
    assert.equal(r.body.url, 'https://github.com/acme/readable/pull/7')
    assert.match(r.body.branch, /^colony\/\d{8}-\d{4}$/)
    assert.equal(r.body.sha, mainSha)
    assert.equal(r.body.mergeRequests, 2)

    const push = c.infra.pushes.at(-1)!
    assert.deepEqual({ ...push }, { slug, url: 'https://github.com/acme/readable.git', srcRef: 'refs/heads/main', dstRef: r.body.branch, token: TOKEN, sha: mainSha })
    const pr = JSON.parse(String(c.calls.at(-1)!.init.body))
    assert.equal(pr.head, r.body.branch)
    assert.equal(pr.base, 'main')
    assert.equal(pr.title, 'Colony: 2 merged quests')
    assert.match(pr.body, /Quest "Streak counter" \(`agent\/streaks`/)
    assert.match(pr.body, /Adds the streak counter/)
    assert.match(pr.body, /agent\/docs/)
    assert.doesNotMatch(pr.body, /agent\/wip/)

    const gh = c.app.store.projects.get(p.id)!.project.github!
    assert.equal(gh.lastPublish!.url, 'https://github.com/acme/readable/pull/7')
    assert.equal(gh.lastPublish!.sha, mainSha)
    assert.ok(c.app.store.recentEvents().some((e) => e.projectId === p.id && /Published to GitHub: https:\/\/github.com\/acme\/readable\/pull\/7/.test(e.text)))
    assertNoToken(c, r.text)

    // Next publish lists only what merged since.
    await mergedMr(c, p, 'agent/next')
    c.respond = async () => json(201, { number: 8, html_url: 'https://github.com/acme/readable/pull/8' })
    const r2 = await api(c, 'POST', `/api/projects/${p.id}/github/publish`)
    assert.equal(r2.body.mergeRequests, 1)
    assert.equal(JSON.parse(String(c.calls.at(-1)!.init.body)).title, 'Colony: 1 merged quest')
  })

  test('pr mode: a GitHub API failure is a redacted 502', async () => {
    const p = await project(c, { repoUrl: 'https://github.com/acme/readable.git' })
    await api(c, 'PUT', '/api/github/token', { token: TOKEN })
    c.respond = async () => json(422, { message: 'Validation Failed', errors: [{ message: `No commits between main and colony; token ${TOKEN}` }] })
    const r = await api(c, 'POST', `/api/projects/${p.id}/github/publish`)
    assert.equal(r.status, 502)
    assert.match(r.body.error.message, /opening the pull request failed: HTTP 422 Validation Failed: No commits/)
    assert.equal(c.app.store.projects.get(p.id)!.project.github!.lastPublish, undefined)
    assert.ok(c.app.store.recentEvents().some((e) => /GitHub publish failed/.test(e.text)))
    assertNoToken(c, r.text)
  })

  test('push mode: fast-forward push to base; non-fast-forward is a 409', async () => {
    const p = await project(c)
    await api(c, 'PATCH', `/api/projects/${p.id}/github`, { repo: 'acme/readable', base: 'main', mode: 'push' })
    await api(c, 'PUT', '/api/github/token', { token: TOKEN })
    const slug = c.app.store.projects.get(p.id)!.slug

    c.infra.nextPushResult({ ok: false, reason: 'non_fast_forward', message: `! [rejected] main -> main (fetch first) Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}` })
    const rej = await api(c, 'POST', `/api/projects/${p.id}/github/publish`)
    assert.equal(rej.status, 409)
    assert.equal(rej.body.error.code, 'non_fast_forward')
    assert.match(rej.body.error.message, /fast-forward/)
    assertNoToken(c, rej.text)

    const ok = await api(c, 'POST', `/api/projects/${p.id}/github/publish`)
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.body.branch, 'main')
    assert.equal(ok.body.url, undefined)
    assert.equal(ok.body.sha, c.infra.projects.get(slug)!.mainSha)
    assert.equal(c.infra.pushes.at(-1)!.dstRef, 'main')
    assert.equal(c.calls.length, 0, 'push mode makes no API call')
    assert.equal(c.app.store.projects.get(p.id)!.project.github!.lastPublish!.mode, 'push')

    c.infra.nextPushResult({ ok: false, reason: 'failed', message: `git push failed (exit 128): fatal: unable to access https://x-access-token:${TOKEN}@github.com/` })
    const fail = await api(c, 'POST', `/api/projects/${p.id}/github/publish`)
    assert.equal(fail.status, 502)
    assertNoToken(c, fail.text, ok.text)
  })
})
