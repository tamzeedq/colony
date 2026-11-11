// Phase 2 backend additions (docs/phase2.md): guards, project PATCH, pause-all, take control /
// hand back, request changes, providers, and the terminal WebSocket. Same style as
// server.test.ts: in-memory InfraDriver fake, temp SQLite DB, real HTTP/WS on port 0.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { Agent, Guards, MergeRequest, Project, RunnerCommand, RunnerMessage, Snapshot, UiStreamMessage } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT, type Config } from './config'
import { createFakeDriver, type FakeDriver } from './infra/fake'
import type { FetchLike, ProviderView } from './providers'
import { DEFAULT_GUARDS } from './store'

const OAUTH = 'sk-ant-oat-test-token-not-real'
const ADMIN = 'admin-secret-for-tests'

interface FetchCall { url: string; init: RequestInit }

interface Ctx {
  app: ColonyApp
  infra: FakeDriver
  base: string
  wsBase: string
  dir: string
  config: Config
  fetchCalls: FetchCall[]
  /** Response for the next provider test call. */
  nextFetch: (call: FetchCall) => Promise<Response>
}

async function setup(over: Partial<Config> = {}, dir = mkdtempSync(join(tmpdir(), 'colony-p2-')), infra = createFakeDriver()): Promise<Ctx> {
  const config = loadConfig({}, {
    dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
    oauthToken: OAUTH, adminToken: ADMIN, port: 0, bind: '127.0.0.1', ...over,
  })
  const ctx = { infra, dir, config, fetchCalls: [] as FetchCall[], nextFetch: async () => new Response('{}', { status: 200 }) } as unknown as Ctx
  const fakeFetch: FetchLike = async (url, init) => {
    const call = { url, init }
    ctx.fetchCalls.push(call)
    return ctx.nextFetch(call)
  }
  ctx.app = await createApp({ config, infra, poll: false, quiet: true, fetch: fakeFetch })
  const port = await ctx.app.start(0, '127.0.0.1')
  ctx.base = `http://127.0.0.1:${port}`
  ctx.wsBase = `ws://127.0.0.1:${port}`
  return ctx
}

async function teardown(c: Ctx) {
  await c.app.close()
  rmSync(c.dir, { recursive: true, force: true })
}

async function api<T = any>(c: Ctx, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; text: string }> {
  const h: Record<string, string> = { authorization: `Bearer ${ADMIN}`, ...headers }
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(c.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* plain text */ }
  return { status: res.status, body: parsed as T, text }
}

class Client<M> {
  readonly messages: M[] = []
  private waiters: { pred: (m: M) => boolean; resolve: (m: M) => void }[] = []
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as M
      this.messages.push(m)
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true))
    })
  }
  static open<M>(url: string, opts?: WebSocket.ClientOptions): Promise<Client<M>> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, opts)
      const c = new Client<M>(ws)
      ws.once('open', () => resolve(c))
      ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode })))
      ws.once('error', reject)
    })
  }
  waitFor(pred: (m: M) => boolean, ms = 2000): Promise<M> {
    const found = this.messages.find(pred)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message')), ms)
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m) } })
    })
  }
  send(m: unknown) { this.ws.send(JSON.stringify(m)) }
  close() { this.ws.close() }
}

const openUi = (c: Ctx) => Client.open<UiStreamMessage>(`${c.wsBase}/api/stream?token=${ADMIN}`)
const openRunner = (c: Ctx, token: string) =>
  Client.open<RunnerCommand>(`${c.wsBase}/api/runner`, { headers: { authorization: `Bearer ${token}` } })

async function createProject(c: Ctx, name = 'Readable') {
  const r = await api<Project>(c, 'POST', '/api/projects', { name, goal: 'Ship streaks', stack: ['Next.js'] })
  assert.equal(r.status, 201, r.text)
  return r.body
}

async function spawnConnected(c: Ctx, projectId: string, body: Record<string, unknown> = { role: 'backend' }) {
  const r = await api<Agent>(c, 'POST', `/api/projects/${projectId}/agents`, body)
  assert.equal(r.status, 201, r.text)
  const token = c.infra.agents.get(r.body.id)!.spec.env.COLONY_AGENT_TOKEN
  const runner = await openRunner(c, token)
  runner.send({ type: 'hello', agentId: r.body.id, protocol: 1 } satisfies RunnerMessage)
  runner.send({ type: 'status', agentId: r.body.id, status: 'idle' } satisfies RunnerMessage)
  await waitUntil(() => c.app.store.agents.get(r.body.id)!.agent.status === 'idle')
  return { agent: r.body, runner }
}

async function waitUntil(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const storedAgent = (c: Ctx, id: string) => JSON.parse(String(c.app.db.get('SELECT data FROM agents WHERE id = ?', id)!.data)) as Agent

// ── guards ────────────────────────────────────────────────────────────────────

describe('guards', () => {
  let c: Ctx
  before(async () => { c = await setup() })
  after(() => teardown(c))

  test('GET returns defaults and the snapshot carries guards', async () => {
    const r = await api<Guards>(c, 'GET', '/api/guards')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, DEFAULT_GUARDS)
    const snap = (await api<Snapshot & { guards: Guards }>(c, 'GET', '/api/snapshot')).body
    assert.deepEqual(snap.guards, DEFAULT_GUARDS)
  })

  test('PATCH merges, persists in kv, is used by guards.ts, and resends the snapshot', async () => {
    const ui = await openUi(c)
    const r = await api<Guards>(c, 'PATCH', '/api/guards', { warnAtPct: 60, pauseWorkersAtPct: 80, paceForecast: false, autoDownshiftAtPct: 85 })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.warnAtPct, 60)
    assert.equal(r.body.pauseWorkersAtPct, 80)
    assert.equal(r.body.paceForecast, false)
    assert.equal(r.body.weeklyWarnAtPct, DEFAULT_GUARDS.weeklyWarnAtPct)
    assert.equal(c.app.db.kvGet<Guards>('guards')!.warnAtPct, 60)
    assert.equal(c.app.store.guards.pauseWorkersAtPct, 80)
    const m = await ui.waitFor((m) => m.type === 'snapshot' && (m.snapshot as Snapshot & { guards: Guards }).guards.warnAtPct === 60)
    assert.ok(m)
    // null clears the optional threshold
    const cleared = await api<Guards>(c, 'PATCH', '/api/guards', { autoDownshiftAtPct: null })
    assert.equal(cleared.status, 200)
    assert.equal('autoDownshiftAtPct' in cleared.body, false)
    ui.close()
  })

  test('the live pauseWorkersAtPct drives plan-usage pausing', async () => {
    await api(c, 'PATCH', '/api/guards', { pauseWorkersAtPct: 50 })
    const p = await createProject(c, 'Guarded')
    const { agent, runner } = await spawnConnected(c, p.id)
    const t = new Date().toISOString()
    runner.send({ type: 'plan_usage', usage: { session: { usedPct: 55, resetsAt: new Date(Date.now() + 3600_000).toISOString(), ratePctPerHour: 0 }, weekly: { usedPct: 10, resetsAt: t }, syncedAt: t, source: 'connected' } } satisfies RunnerMessage)
    await waitUntil(() => c.app.store.agents.get(agent.id)!.agent.status === 'paused')
    runner.close()
  })

  test('validation', async () => {
    for (const bad of [{ warnAtPct: 101 }, { warnAtPct: -1 }, { warnAtPct: '50' }, { paceForecast: 'yes' }, { nope: 1 }, { pauseWorkersAtPct: null }]) {
      const r = await api(c, 'PATCH', '/api/guards', bad)
      assert.equal(r.status, 400, JSON.stringify(bad))
      assert.equal(r.body.error.code, 'bad_request')
    }
    assert.equal((await api(c, 'GET', '/api/guards', undefined, { authorization: 'Bearer wrong' })).status, 401)
  })
})

// ── projects, agents, merge requests ─────────────────────────────────────────

describe('project PATCH, pause-all, take control, request changes', () => {
  let c: Ctx
  before(async () => { c = await setup() })
  after(() => teardown(c))

  test('PATCH /api/projects/:id forwards a new goal to the orchestrator and broadcasts', async () => {
    const p = await createProject(c)
    const { agent: orch, runner } = await spawnConnected(c, p.id, { role: 'orchestrator' })
    const ui = await openUi(c)
    const r = await api<{ project: Project; forwardedTo?: string }>(c, 'PATCH', `/api/projects/${p.id}`, { goal: 'Launch the beta by Friday' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.project.goal, 'Launch the beta by Friday')
    assert.equal(r.body.forwardedTo, orch.id)
    const msg = await runner.waitFor((m) => m.type === 'user_message' && m.text.includes('Launch the beta'))
    assert.ok(msg.type === 'user_message')
    assert.equal(msg.text, 'New goal from the commander: Launch the beta by Friday')
    await ui.waitFor((m) => m.type === 'snapshot' && m.snapshot.projects.some((x) => x.goal === 'Launch the beta by Friday'))

    const cap = await api<{ project: Project }>(c, 'PATCH', `/api/projects/${p.id}`, { dailyCapUsd: 42 })
    assert.equal(cap.status, 200)
    assert.equal(cap.body.project.dailyCapUsd, 42)
    assert.equal(c.app.store.projects.get(p.id)!.project.dailyCapUsd, 42)
    // only one goal message: the cap change did not resend it
    assert.equal(runner.messages.filter((m) => m.type === 'user_message' && m.text.startsWith('New goal')).length, 1)

    assert.equal((await api(c, 'PATCH', `/api/projects/${p.id}`, {})).status, 400)
    assert.equal((await api(c, 'PATCH', `/api/projects/${p.id}`, { dailyCapUsd: -1 })).status, 400)
    assert.equal((await api(c, 'PATCH', '/api/projects/p-nope', { goal: 'x' })).status, 404)
    runner.close(); ui.close()
  })

  test('PATCH goal without an orchestrator just updates the project', async () => {
    const p = await createProject(c, 'NoOrch')
    const r = await api<{ project: Project; forwardedTo?: string }>(c, 'PATCH', `/api/projects/${p.id}`, { goal: 'Solo' })
    assert.equal(r.status, 200)
    assert.equal(r.body.forwardedTo, undefined)
    assert.equal(r.body.project.goal, 'Solo')
  })

  test('POST /api/agents/pause-all pauses every live agent', async () => {
    const p = await createProject(c, 'Pausing')
    const a = await spawnConnected(c, p.id, { role: 'backend' })
    const b = await spawnConnected(c, p.id, { role: 'qa' })
    const r = await api<{ paused: string[] }>(c, 'POST', '/api/agents/pause-all')
    assert.equal(r.status, 200, r.text)
    assert.ok(r.body.paused.includes(a.agent.id) && r.body.paused.includes(b.agent.id))
    await a.runner.waitFor((m) => m.type === 'pause')
    await b.runner.waitFor((m) => m.type === 'pause')
    assert.equal(c.app.store.agents.get(a.agent.id)!.agent.status, 'paused')
    // already paused → not paused again
    const again = await api<{ paused: string[] }>(c, 'POST', '/api/agents/pause-all')
    assert.deepEqual(again.body.paused, [])
    a.runner.close(); b.runner.close()
  })

  test('take-control pauses and records the controller; hand-back resumes and tells the agent what changed', async () => {
    const p = await createProject(c, 'Control')
    const { agent, runner } = await spawnConnected(c, p.id)
    const ui = await openUi(c)

    const t = await api<Agent>(c, 'POST', `/api/agents/${agent.id}/take-control`)
    assert.equal(t.status, 200, t.text)
    assert.equal(t.body.controller, 'you')
    assert.equal(t.body.status, 'paused')
    await runner.waitFor((m) => m.type === 'pause')
    assert.equal(storedAgent(c, agent.id).controller, 'you')
    await ui.waitFor((m) => m.type === 'agent_delta' && m.agentId === agent.id && m.patch.controller === 'you')
    await ui.waitFor((m) => m.type === 'event' && m.event.agentId === agent.id && m.event.text === 'You took control')
    const snap = (await api<Snapshot>(c, 'GET', '/api/snapshot')).body
    assert.equal(snap.agents.find((a) => a.id === agent.id)!.controller, 'you')

    c.infra.execHandler = (_id, cmd) => {
      if (cmd.includes('diff')) return { exitCode: 0, stdout: ' src/streaks.ts | 12 ++++++++----\n 1 file changed, 8 insertions(+), 4 deletions(-)\n', stderr: '' }
      if (cmd.includes('status')) return { exitCode: 0, stdout: ' M src/streaks.ts\n?? notes.md\n', stderr: '' }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' }
    }
    const h = await api<{ agent: Agent; message: string }>(c, 'POST', `/api/agents/${agent.id}/hand-back`, { note: 'Fixed the off-by-one in the streak counter' })
    assert.equal(h.status, 200, h.text)
    assert.equal(h.body.agent.controller, 'agent')
    const execs = c.infra.callsTo('execInAgent').map((x) => x.args[1] as string[])
    assert.deepEqual(execs.find((a) => a.includes('diff')), ['git', '-C', '/workspace', 'diff', '--stat', 'HEAD'])
    assert.deepEqual(execs.find((a) => a.includes('status')), ['git', '-C', '/workspace', 'status', '--short'])

    const resumeIdx = await runner.waitFor((m) => m.type === 'resume').then(() => runner.messages.findIndex((m) => m.type === 'resume'))
    const um = await runner.waitFor((m) => m.type === 'user_message' && m.text.includes('handed it back'))
    assert.ok(um.type === 'user_message')
    assert.ok(runner.messages.indexOf(um) > resumeIdx, 'resume is sent before the summary')
    assert.match(um.text, /took control/)
    assert.match(um.text, /src\/streaks\.ts \| 12/)
    assert.match(um.text, /\?\? notes\.md/)
    assert.match(um.text, /Fixed the off-by-one/)
    assert.equal(storedAgent(c, agent.id).controller, 'agent')
    assert.notEqual(c.app.store.agents.get(agent.id)!.agent.status, 'paused')
    await ui.waitFor((m) => m.type === 'event' && m.event.agentId === agent.id && m.event.text === 'You handed control back')

    // not under your control any more
    assert.equal((await api(c, 'POST', `/api/agents/${agent.id}/hand-back`, {})).status, 409)
    assert.equal((await api(c, 'POST', '/api/agents/nobody-00-000000/take-control')).status, 404)
    runner.close(); ui.close()
  })

  test('hand-back still works when the workspace cannot be read', async () => {
    const p = await createProject(c, 'Control2')
    const { agent, runner } = await spawnConnected(c, p.id)
    await api(c, 'POST', `/api/agents/${agent.id}/take-control`)
    c.infra.execHandler = () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' })
    const h = await api<{ agent: Agent; message: string }>(c, 'POST', `/api/agents/${agent.id}/hand-back`)
    assert.equal(h.status, 200, h.text)
    assert.match(h.body.message, /not a git repository/)
    assert.doesNotMatch(h.body.message, /Their note/)
    runner.close()
  })

  test('request-changes sets changes_requested, messages the requester, and updates the stream', async () => {
    const p = await createProject(c, 'Review')
    const { agent, runner } = await spawnConnected(c, p.id, { role: 'backend' })
    c.infra.setBranch('review', 'agent/feature')
    const mr = (await api<MergeRequest>(c, 'POST', '/api/merge-requests', { projectId: p.id, branch: 'agent/feature', requestedBy: agent.id })).body
    const snap = (await api<Snapshot>(c, 'GET', '/api/snapshot')).body
    assert.ok(snap.mergeRequests!.some((m) => m.id === mr.id && m.status === 'pending'))
    const ui = await openUi(c)

    assert.equal((await api(c, 'POST', `/api/merge-requests/${mr.id}/request-changes`, {})).status, 400)
    const r = await api<MergeRequest>(c, 'POST', `/api/merge-requests/${mr.id}/request-changes`, { note: 'Please add tests for the empty streak case' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.status, 'changes_requested')
    const um = await runner.waitFor((m) => m.type === 'user_message' && m.text.includes('requested changes'))
    assert.ok(um.type === 'user_message')
    assert.match(um.text, /agent\/feature/)
    assert.match(um.text, /add tests for the empty streak case/)
    await ui.waitFor((m) => m.type === 'snapshot' && m.snapshot.mergeRequests!.some((x) => x.id === mr.id && x.status === 'changes_requested'))
    assert.ok(c.app.store.alerts.get(`al-${mr.id}`)!.resolvedAt, 'approval alert resolved')
    assert.equal(c.app.store.mergeRequests.get(mr.id)!.status, 'changes_requested')

    // approve still works afterwards, and a merged request cannot be sent back
    const ap = await api(c, 'POST', `/api/merge-requests/${mr.id}/approve`)
    assert.equal(ap.status, 200, ap.text)
    assert.equal((await api(c, 'POST', `/api/merge-requests/${mr.id}/request-changes`, { note: 'late' })).status, 409)
    assert.equal((await api(c, 'POST', '/api/merge-requests/mr-nope/request-changes', { note: 'x' })).status, 404)
    runner.close(); ui.close()
  })
})

// ── providers ────────────────────────────────────────────────────────────────

describe('providers', () => {
  let c: Ctx
  const KEY = 'sk-ant-api03-SUPERSECRETvalue-9f3a'
  before(async () => { c = await setup() })
  after(() => teardown(c))

  const noKeyIn = (s: string, key = KEY) => assert.ok(!s.includes(key) && !s.includes(key.slice(4, -4)), 'secret leaked')

  test('GET lists every provider; the subscription is built in', async () => {
    const r = await api<ProviderView[]>(c, 'GET', '/api/providers')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.map((p) => p.id), ['claude-subscription', 'anthropic-api', 'openai', 'google', 'openrouter', 'custom'])
    const sub = r.body[0]
    assert.equal(sub.kind, 'subscription')
    assert.equal(sub.hasKey, true)
    assert.ok(sub.models.includes('opus-5.5'))
    assert.equal(r.body[1].status, 'missing_key')
    assert.equal(r.body[1].hasKey, false)
    assert.equal((await api(c, 'PUT', '/api/providers/claude-subscription', { apiKey: 'x'.repeat(20) })).status, 400)
    assert.equal((await api(c, 'PUT', '/api/providers/nope', { apiKey: 'x'.repeat(20) })).status, 404)
  })

  test('PUT stores the key encrypted and responses only carry a masked hint', async () => {
    assert.equal(existsSync(join(c.dir, 'master.key')), false, 'master.key is created on first use')
    const ui = await openUi(c)
    const r = await api<ProviderView>(c, 'PUT', '/api/providers/anthropic-api', { apiKey: KEY })
    assert.equal(r.status, 200, r.text)
    noKeyIn(r.text)
    assert.equal(r.body.hasKey, true)
    assert.equal(r.body.keyHint, 'sk-…9f3a')
    assert.equal(r.body.status, 'untested')
    assert.equal(readFileSync(join(c.dir, 'master.key')).length, 32)

    // raw kv value and the DB files never contain the key
    const raw = String(c.app.db.get("SELECT value FROM kv WHERE key = 'provider:anthropic-api'")!.value)
    noKeyIn(raw)
    assert.match(raw, /"key":"v1:/)
    for (const f of readdirSync(c.dir).filter((f) => f.startsWith('colony.db'))) noKeyIn(readFileSync(join(c.dir, f)).toString('latin1'))

    noKeyIn((await api(c, 'GET', '/api/providers')).text)
    noKeyIn((await api(c, 'GET', '/api/snapshot')).text)
    const m = await ui.waitFor((m) => m.type === 'snapshot' && m.snapshot.providers!.some((p) => p.id === 'anthropic-api' && p.hasKey))
    noKeyIn(JSON.stringify(m))
    ui.close()

    for (const bad of [{ apiKey: '' }, { apiKey: 'has space inside key' }, { apiKey: 42 }, { baseUrl: 'https://x.example/v1' }, { other: 1 }]) {
      assert.equal((await api(c, 'PUT', '/api/providers/anthropic-api', bad)).status, 400, JSON.stringify(bad))
    }
  })

  test('test: 2xx → connected (with the decrypted key sent the documented way)', async () => {
    c.nextFetch = async () => new Response('{"data":[]}', { status: 200 })
    const r = await api<ProviderView>(c, 'POST', '/api/providers/anthropic-api/test')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.status, 'connected')
    assert.ok(r.body.testedAt)
    const call = c.fetchCalls.at(-1)!
    assert.equal(call.url, 'https://api.anthropic.com/v1/models')
    const h = call.init.headers as Record<string, string>
    assert.equal(h['x-api-key'], KEY)
    assert.equal(h['anthropic-version'], '2023-06-01')
    assert.equal(call.init.redirect, 'manual')
    assert.ok(call.init.signal, 'has a timeout signal')
  })

  test('test: 401 → error with a short reason that never echoes the key', async () => {
    c.nextFetch = async () => new Response(JSON.stringify({ error: { message: `invalid x-api-key ${KEY}` } }), { status: 401, statusText: 'Unauthorized' })
    const r = await api<ProviderView>(c, 'POST', '/api/providers/anthropic-api/test')
    assert.equal(r.body.status, 'error')
    assert.match(r.body.statusDetail!, /^HTTP 401/)
    noKeyIn(r.text)
  })

  test('test: timeout and network errors → error', async () => {
    c.nextFetch = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }
    const r = await api<ProviderView>(c, 'POST', '/api/providers/anthropic-api/test')
    assert.equal(r.body.status, 'error')
    assert.match(r.body.statusDetail!, /timed out after 10 s/)
    c.nextFetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) }
    const n = await api<ProviderView>(c, 'POST', '/api/providers/anthropic-api/test')
    assert.match(n.body.statusDetail!, /ENOTFOUND/)
  })

  test('openai, openrouter, google and custom use their own endpoints and auth', async () => {
    c.nextFetch = async () => new Response('{}', { status: 200 })
    const keys = { openai: 'sk-proj-openaiKEY-12345678', openrouter: 'sk-or-v1-routerKEY-1234', google: 'AIzaSyGoogleKEY-abcdefgh', custom: 'custom-KEY-0000-1111' }
    await api(c, 'PUT', '/api/providers/openai', { apiKey: keys.openai, models: ['gpt-5'] })
    await api(c, 'PUT', '/api/providers/openrouter', { apiKey: keys.openrouter })
    await api(c, 'PUT', '/api/providers/google', { apiKey: keys.google })
    const cu = await api<ProviderView>(c, 'PUT', '/api/providers/custom', { apiKey: keys.custom, baseUrl: 'http://localhost:11434/v1/', models: 'llama-4, qwen-3' })
    assert.equal(cu.status, 200, cu.text)
    assert.equal(cu.body.baseUrl, 'http://localhost:11434/v1/')
    assert.deepEqual(cu.body.models, ['llama-4', 'qwen-3'])
    assert.equal((await api(c, 'PUT', '/api/providers/custom', { baseUrl: 'ftp://x' })).status, 400)

    const seen: Record<string, FetchCall> = {}
    for (const id of ['openai', 'openrouter', 'google', 'custom'] as const) {
      const r = await api<ProviderView>(c, 'POST', `/api/providers/${id}/test`)
      assert.equal(r.body.status, 'connected', `${id}: ${r.text}`)
      seen[id] = c.fetchCalls.at(-1)!
      noKeyIn(r.text, keys[id])
    }
    const hdr = (id: string) => seen[id].init.headers as Record<string, string>
    assert.equal(seen.openai.url, 'https://api.openai.com/v1/models')
    assert.equal(hdr('openai').authorization, `Bearer ${keys.openai}`)
    assert.equal(seen.openrouter.url, 'https://openrouter.ai/api/v1/models')
    assert.equal(hdr('openrouter').authorization, `Bearer ${keys.openrouter}`)
    assert.equal(seen.google.url, 'https://generativelanguage.googleapis.com/v1beta/models')
    assert.equal(hdr('google')['x-goog-api-key'], keys.google)
    assert.equal(seen.custom.url, 'http://localhost:11434/v1/models')
    assert.equal(hdr('custom').authorization, `Bearer ${keys.custom}`)
    const list = (await api<ProviderView[]>(c, 'GET', '/api/providers')).body
    assert.deepEqual(list.find((p) => p.id === 'openai')!.models, ['gpt-5'])
  })

  test('DELETE key → missing_key; test without a key makes no request', async () => {
    const d = await api<ProviderView>(c, 'DELETE', '/api/providers/anthropic-api/key')
    assert.equal(d.status, 200)
    assert.equal(d.body.hasKey, false)
    assert.equal(d.body.status, 'missing_key')
    assert.equal(d.body.keyHint, undefined)
    const raw = String(c.app.db.get("SELECT value FROM kv WHERE key = 'provider:anthropic-api'")!.value)
    assert.doesNotMatch(raw, /"key"/)
    const before = c.fetchCalls.length
    const t = await api<ProviderView>(c, 'POST', '/api/providers/anthropic-api/test')
    assert.equal(t.body.status, 'missing_key')
    assert.equal(c.fetchCalls.length, before)
    assert.equal((await api(c, 'DELETE', '/api/providers/claude-subscription/key')).status, 400)
  })

  test('a key survives a restart (same master.key) and still decrypts', async () => {
    const infra = c.infra
    await api(c, 'PUT', '/api/providers/anthropic-api', { apiKey: KEY })
    await c.app.close()
    const c2 = await setup({}, c.dir, infra)
    c = c2
    c.nextFetch = async () => new Response('{}', { status: 200 })
    const r = await api<ProviderView>(c, 'POST', '/api/providers/anthropic-api/test')
    assert.equal(r.body.status, 'connected')
    assert.equal((c.fetchCalls.at(-1)!.init.headers as Record<string, string>)['x-api-key'], KEY)
  })
})

// ── terminal ─────────────────────────────────────────────────────────────────

interface Term {
  ws: WebSocket
  output: () => string
  closed: Promise<{ code: number; reason: string }>
}

function openTerm(c: Ctx, agentId: string, q = `token=${ADMIN}&cols=100&rows=30`, opts?: WebSocket.ClientOptions): Promise<Term> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${c.wsBase}/api/agents/${agentId}/terminal?${q}`, opts)
    const chunks: Buffer[] = []
    ws.on('message', (d: Buffer, isBinary) => { if (isBinary) chunks.push(d) })
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })))
    ws.once('open', () => resolve({ ws, output: () => Buffer.concat(chunks).toString('utf8'), closed }))
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode })))
    ws.once('error', reject)
  })
}

describe('terminal WebSocket', () => {
  let c: Ctx
  let agentId: string
  before(async () => {
    c = await setup()
    const p = await createProject(c, 'Shells')
    agentId = (await spawnConnected(c, p.id)).agent.id
  })
  after(() => teardown(c))

  test('rejects missing/wrong tokens, foreign origins and unknown agents before the upgrade', async () => {
    await assert.rejects(openTerm(c, agentId, 'cols=80&rows=24'), (e: any) => e.statusCode === 401)
    await assert.rejects(openTerm(c, agentId, 'token=wrong'), (e: any) => e.statusCode === 401)
    await assert.rejects(openTerm(c, agentId, `token=${ADMIN}`, { headers: { origin: 'http://evil.example' } }), (e: any) => e.statusCode === 403)
    await assert.rejects(openTerm(c, 'ghost-00-000000', `token=${ADMIN}`), (e: any) => e.statusCode === 404)
    assert.equal(c.infra.shells.length, 0)
  })

  test('echoes through the shell, forwards resize, records open/close and kills on close', async () => {
    const ui = await openUi(c)
    const t = await openTerm(c, agentId, `token=${ADMIN}&cols=100&rows=30`, { headers: { origin: 'http://localhost:5173' } })
    await waitUntil(() => c.infra.shells.length === 1)
    const shell = c.infra.shells[0]
    assert.equal(shell.agentId, agentId)
    assert.equal(shell.cols, 100)
    assert.equal(shell.rows, 30)
    await ui.waitFor((m) => m.type === 'event' && m.event.agentId === agentId && m.event.text === 'Terminal opened')

    t.ws.send(Buffer.from('echo hello\r'), { binary: true })
    await waitUntil(() => t.output().includes('echo hello'))
    assert.equal(shell.input, 'echo hello\r')

    t.ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 40 }))
    await waitUntil(() => shell.resizes.length === 1)
    assert.deepEqual(shell.resizes[0], [132, 40])
    t.ws.send(JSON.stringify({ type: 'resize', cols: 0, rows: 'x' })) // ignored
    t.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }))
    await waitUntil(() => shell.resizes.length === 2)
    assert.equal(shell.input, 'echo hello\r', 'control messages are not input')

    t.ws.close()
    await waitUntil(() => shell.killed)
    await ui.waitFor((m) => m.type === 'event' && m.event.agentId === agentId && m.event.text === 'Terminal closed')
    await waitUntil(() => c.app.terminals.count(agentId) === 0)
    ui.close()
  })

  test('at most 3 terminals per agent: the 4th is closed with 4008', async () => {
    const before = c.infra.shells.length
    const ts = [await openTerm(c, agentId), await openTerm(c, agentId), await openTerm(c, agentId)]
    await waitUntil(() => c.infra.shells.length === before + 3)
    const fourth = await openTerm(c, agentId)
    const { code, reason } = await fourth.closed
    assert.equal(code, 4008)
    assert.match(reason, /too many terminals/)
    assert.equal(c.infra.shells.length, before + 3, 'no shell opened for the rejected one')
    // closing one frees a slot
    ts[0].ws.close()
    await waitUntil(() => c.app.terminals.count(agentId) === 2)
    const again = await openTerm(c, agentId)
    await waitUntil(() => c.infra.shells.length === before + 4)
    for (const t of [...ts.slice(1), again]) t.ws.close()
    await waitUntil(() => c.app.terminals.count(agentId) === 0)
    assert.ok(c.infra.shells.slice(before).every((s) => s.killed), 'every shell killed')
  })

  test('the socket closes with 1000 when the shell exits', async () => {
    const t = await openTerm(c, agentId)
    await waitUntil(() => c.app.terminals.count(agentId) === 1 && c.infra.shells.at(-1)!.handle !== undefined)
    const shell = c.infra.shells.at(-1)!
    shell.exit()
    const { code } = await t.closed
    assert.equal(code, 1000)
    await waitUntil(() => c.app.terminals.count(agentId) === 0)
  })

  test('a stopped container closes with 4009', async () => {
    c.infra.agents.get(agentId)!.running = false
    try {
      const t = await openTerm(c, agentId)
      const { code, reason } = await t.closed
      assert.equal(code, 4009)
      assert.match(reason, /not running/)
    } finally {
      c.infra.agents.get(agentId)!.running = true
    }
  })

  test('idle terminals are closed and killed', async () => {
    const c2 = await setup({ terminalIdleMs: 150 })
    try {
      const p = await createProject(c2, 'Idle')
      const { agent, runner } = await spawnConnected(c2, p.id)
      const t = await openTerm(c2, agent.id)
      const { code, reason } = await t.closed
      assert.equal(code, 4000)
      assert.match(reason, /idle/)
      await waitUntil(() => c2.infra.shells[0]?.killed === true)
      runner.close()
    } finally { await teardown(c2) }
  })
})
