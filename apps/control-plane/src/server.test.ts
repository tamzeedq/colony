// End-to-end tests of the control plane against the in-memory InfraDriver fake, a temp
// SQLite DB, real HTTP and real WebSockets on an ephemeral port.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { Agent, Alert, AgentStatus, Project, RunnerCommand, RunnerMessage, Snapshot, UiStreamMessage } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT, type Config } from './config'
import { createFakeDriver, type FakeDriver } from './infra/fake'
import { sha256 } from './agents'

const OAUTH = 'sk-ant-oat-test-token-not-real'

interface Ctx {
  app: ColonyApp
  infra: FakeDriver
  base: string
  wsBase: string
  dir: string
  config: Config
}

async function setup(over: Partial<Config> = {}, dir = mkdtempSync(join(tmpdir(), 'colony-cp-')), infra = createFakeDriver()): Promise<Ctx> {
  const config = loadConfig({}, {
    dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
    oauthToken: OAUTH, port: 0, bind: '127.0.0.1', publicRunnerUrl: 'ws://host.docker.internal:7700/api/runner', maxAgentsPerProject: 50, ...over,
  })
  const app = await createApp({ config, infra, poll: false, quiet: true })
  const port = await app.start(0, '127.0.0.1')
  return { app, infra, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}`, dir, config }
}

async function teardown(c: Ctx, rm = true) {
  await c.app.close()
  if (rm) rmSync(c.dir, { recursive: true, force: true })
}

async function api<T = any>(c: Ctx, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(c.base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* plain text */ }
  return { status: res.status, body: parsed as T }
}

/** A WS client that records every JSON message and can wait for one matching a predicate. */
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

const openUi = (c: Ctx) => Client.open<UiStreamMessage>(`${c.wsBase}/api/stream`)
const openRunner = (c: Ctx, token: string) =>
  Client.open<RunnerCommand>(`${c.wsBase}/api/runner`, { headers: { authorization: `Bearer ${token}` } })

async function createProject(c: Ctx, body: Record<string, unknown> = { name: 'Readable', goal: 'Ship streaks', stack: ['Next.js', 'Supabase'] }) {
  const r = await api<Project>(c, 'POST', '/api/projects', body)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}

async function spawn(c: Ctx, projectId: string, body: Record<string, unknown> = { role: 'backend', task: 'Build the streaks API' }) {
  const r = await api<Agent>(c, 'POST', `/api/projects/${projectId}/agents`, body)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const spec = c.infra.agents.get(r.body.id)!.spec
  return { agent: r.body, env: spec.env, token: spec.env.COLONY_AGENT_TOKEN }
}

/** Spawn and connect a runner that has said hello; returns once the agent is idle. */
async function spawnConnected(c: Ctx, projectId: string, body?: Record<string, unknown>) {
  const s = await spawn(c, projectId, body)
  const runner = await openRunner(c, s.token)
  runner.send({ type: 'hello', agentId: s.agent.id, protocol: 1 } satisfies RunnerMessage)
  runner.send({ type: 'status', agentId: s.agent.id, status: 'idle' } satisfies RunnerMessage) // real runners report status after hello
  await waitUntil(() => c.app.store.agents.get(s.agent.id)!.agent.status !== 'booting')
  return { ...s, runner }
}

async function waitUntil(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const status = (c: Ctx, id: string): AgentStatus => c.app.store.agents.get(id)!.agent.status

// ── tests ─────────────────────────────────────────────────────────────────────

describe('projects', () => {
  let c: Ctx
  before(async () => { c = await setup() })
  after(() => teardown(c))

  test('create project calls ensureProject and appears in the snapshot', async () => {
    const p = await createProject(c)
    const calls = c.infra.callsTo('ensureProject')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].args[0], 'readable')
    assert.equal(p.key, 1)
    assert.equal(p.health.label, 'dormant')
    const snap = (await api<Snapshot>(c, 'GET', '/api/snapshot')).body
    assert.equal(snap.projects.length, 1)
    assert.equal(snap.projects[0].name, 'Readable')
    assert.deepEqual(snap.projects[0].stack, ['Next.js', 'Supabase'])
    assert.equal(snap.resources.usage.source, 'unavailable')
    assert.equal(snap.resources.containers.max, 12)
    assert.equal(snap.resources.host.docker, 'running')
    assert.ok(snap.models && snap.models.length >= 4)
    // never leak the subscription token
    assert.ok(!JSON.stringify(snap).includes(OAUTH))
  })

  test('second project with the same name gets a unique slug and the next key', async () => {
    const p = await createProject(c, { name: 'Readable' })
    assert.equal(p.key, 2)
    assert.equal(c.infra.callsTo('ensureProject')[1].args[0], 'readable-2')
  })

  test('validation errors are JSON', async () => {
    const r = await api(c, 'POST', '/api/projects', { goal: 'x' })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'bad_request')
    const bad = await api(c, 'POST', '/api/projects', { name: 'X', repoUrl: 'file:///etc' })
    assert.equal(bad.status, 400)
    const nf = await api(c, 'POST', '/api/agents/nope/pause')
    assert.equal(nf.status, 404)
  })

  test('delete project stops agents and removes infra', async () => {
    const p = await createProject(c, { name: 'Doomed' })
    const { agent } = await spawn(c, p.id)
    const r = await api(c, 'DELETE', `/api/projects/${p.id}?purge=1`)
    assert.equal(r.status, 200)
    assert.ok(c.infra.callsTo('stopAgent').some((x) => x.args[0] === agent.id))
    assert.ok(c.infra.callsTo('removeAgentVolume').some((x) => x.args[0] === agent.id))
    assert.deepEqual(c.infra.callsTo('removeProject').at(-1)!.args, ['doomed', { purge: true }])
    assert.ok(!c.app.store.projects.has(p.id))
    assert.ok(!c.app.store.agents.has(agent.id))
  })
})

describe('agents and runners', () => {
  let c: Ctx
  let project: Project
  before(async () => { c = await setup(); project = await createProject(c) })
  after(() => teardown(c))

  test('spawn passes the documented env, hashes the token, and starts booting', async () => {
    const { agent, env, token } = await spawn(c, project.id)
    for (const k of ['COLONY_AGENT_ID', 'COLONY_PROJECT_ID', 'COLONY_CONTROL_URL', 'COLONY_AGENT_TOKEN', 'COLONY_GIT_URL',
      'COLONY_BRANCH', 'COLONY_MODEL', 'COLONY_SYSTEM_PROMPT_B64', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      assert.ok(env[k], `missing ${k}`)
    }
    assert.equal(env.COLONY_AGENT_ID, agent.id)
    assert.equal(env.COLONY_PROJECT_ID, project.id)
    assert.equal(env.COLONY_CONTROL_URL, 'ws://host.docker.internal:7700/api/runner')
    assert.equal(env.COLONY_GIT_URL, 'git://git/repo.git')
    assert.equal(env.COLONY_MODEL, 'claude-sonnet-5-5')
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH)
    assert.match(agent.callsign, /^[A-Z][a-z]+-\d{2}$/)
    assert.equal(env.COLONY_BRANCH, `agent/${agent.callsign.toLowerCase()}`)
    assert.equal(agent.branch, env.COLONY_BRANCH)
    const prompt = Buffer.from(env.COLONY_SYSTEM_PROMPT_B64, 'base64').toString('utf8')
    assert.match(prompt, /Readable/)
    assert.match(prompt, /Next\.js, Supabase/)
    assert.match(prompt, /# Role: Backend/i)
    assert.equal(agent.status, 'booting')
    assert.equal(agent.provider, 'claude-subscription')
    assert.equal(c.infra.agents.get(agent.id)!.spec.image, 'colony-agent:dev')

    // token: only its hash is stored, nowhere in the DB in clear; OAuth token never stored
    const row = c.app.db.get('SELECT token_hash FROM agents WHERE id = ?', agent.id)!
    assert.equal(row.token_hash, sha256(token))
    for (const table of ['projects', 'agents', 'events', 'alerts', 'kv', 'merge_requests']) {
      const dump = JSON.stringify(c.app.db.all(`SELECT * FROM ${table}`))
      assert.ok(!dump.includes(token), `token found in ${table}`)
      assert.ok(!dump.includes(OAUTH), `oauth token found in ${table}`)
    }
  })

  test('runner with the token connects, goes idle, and gets the initial task', async () => {
    const ui = await openUi(c)
    const { agent, token } = await spawn(c, project.id, { role: 'frontend', task: 'Build the streak widget', model: 'haiku-5.5' })
    const runner = await openRunner(c, token)
    runner.send({ type: 'hello', agentId: agent.id, protocol: 1 })
    runner.send({ type: 'status', agentId: agent.id, status: 'idle' }) // real runners report status after hello
    const cmd = await runner.waitFor((m) => m.type === 'user_message')
    assert.deepEqual(cmd, { type: 'user_message', text: 'Build the streak widget' })
    await ui.waitFor((m) => m.type === 'agent_delta' && m.agentId === agent.id && m.patch.status === 'idle')
    assert.equal(status(c, agent.id), 'idle')
    assert.equal(c.app.store.agents.get(agent.id)!.internal.pending.length, 0)
    ui.close(); runner.close()
  })

  test('bad or missing tokens are rejected', async () => {
    await assert.rejects(openRunner(c, 'not-a-token'), (e: any) => e.statusCode === 401)
    await assert.rejects(Client.open(`${c.wsBase}/api/runner`), (e: any) => e.statusCode === 401)
  })

  test('runner events, usage and plan_usage flow to the UI stream', async () => {
    const ui = await openUi(c)
    const snap = await ui.waitFor((m) => m.type === 'snapshot')
    assert.equal(snap.type, 'snapshot')
    const { agent, runner } = await spawnConnected(c, project.id)
    const ev = { id: 'toolu_1', at: new Date().toISOString(), agentId: 'spoofed', projectId: 'spoofed', kind: 'command' as const,
      text: 'npm test', command: { cmd: 'npm test', running: true } }
    runner.send({ type: 'event', event: ev })
    runner.send({ type: 'status', agentId: agent.id, status: 'running' })
    runner.send({ type: 'usage', inputTokens: 1000, outputTokens: 500, costUsd: 0.25 })
    const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString()
    runner.send({ type: 'plan_usage', usage: { session: { usedPct: 30, resetsAt, ratePctPerHour: 0 }, weekly: { usedPct: 10, resetsAt }, syncedAt: new Date().toISOString(), source: 'connected' } })
    runner.send({ type: 'plan_usage', usage: { session: { usedPct: 34, resetsAt, ratePctPerHour: 0 }, weekly: { usedPct: 10, resetsAt }, syncedAt: new Date().toISOString(), source: 'connected' } }) // +4 points credited to this agent

    const got = await ui.waitFor((m) => m.type === 'event' && m.event.id === 'toolu_1')
    assert.ok(got.type === 'event')
    assert.equal(got.event.agentId, agent.id, 'agent id is forced to the authenticated agent')
    assert.equal(got.event.projectId, project.id)
    await ui.waitFor((m) => m.type === 'agent_delta' && m.agentId === agent.id && m.patch.status === 'running')
    await ui.waitFor((m) => m.type === 'agent_delta' && m.agentId === agent.id && m.patch.currentAction === 'npm test')
    const spend = await ui.waitFor((m) => m.type === 'agent_delta' && m.agentId === agent.id && m.patch.spendTodayUsd !== undefined)
    assert.ok(spend.type === 'agent_delta')
    assert.equal(spend.patch.spendTodayUsd, 0.25)
    assert.equal(spend.patch.tokensToday, 1500)
    const res = await ui.waitFor((m) => m.type === 'resources' && m.resources.usage.source === 'connected')
    assert.ok(res.type === 'resources')
    assert.equal(res.resources.usage.session.usedPct, 30)
    assert.ok(res.resources.usage.session.ratePctPerHour > 0, 'rate derived from the window start')
    assert.equal(res.resources.spendTodayUsd, 0.25)

    // upsert by id: the finished command replaces the running one
    runner.send({ type: 'event', event: { ...ev, command: { cmd: 'npm test', running: false, exitCode: 0 } } })
    await ui.waitFor((m) => m.type === 'event' && m.event.id === 'toolu_1' && m.event.command?.exitCode === 0)
    const events = (await api(c, 'GET', `/api/agents/${agent.id}/events?limit=10`)).body as any[]
    assert.equal(events.filter((e) => e.id === 'toolu_1').length, 1)
    assert.equal(events.find((e) => e.id === 'toolu_1').command.exitCode, 0)

    // project spend + snapshot completeness
    const s2 = (await api<Snapshot>(c, 'GET', '/api/snapshot')).body
    const p = s2.projects.find((x) => x.id === project.id)!
    assert.ok(p.spendTodayUsd >= 0.25)
    assert.ok(p.agentIds.includes(agent.id))
    const a = s2.agents.find((x) => x.id === agent.id)!
    assert.equal(a.level, 1)
    assert.equal(a.sessionShare, 0.04) // only the rise between this agent's own reports
    // invalid frames are ignored, the connection stays up
    runner.ws.send('{"type":"nonsense"}')
    runner.ws.send('not json')
    runner.send({ type: 'workspace', branch: a.branch!, headSha: 'abc' })
    await waitUntil(() => runner.ws.readyState === WebSocket.OPEN)
    ui.close(); runner.close()
  })

  test('pause, resume, interrupt, message and set_model reach the runner', async () => {
    const { agent, runner } = await spawnConnected(c, project.id, { role: 'qa' })
    assert.equal((await api(c, 'POST', `/api/agents/${agent.id}/pause`)).status, 200)
    await runner.waitFor((m) => m.type === 'pause')
    assert.equal(status(c, agent.id), 'paused')
    assert.equal((await api(c, 'POST', `/api/agents/${agent.id}/resume`, {})).status, 200)
    await runner.waitFor((m) => m.type === 'resume')
    assert.equal(status(c, agent.id), 'idle')
    assert.equal((await api(c, 'POST', `/api/agents/${agent.id}/interrupt`)).status, 200)
    await runner.waitFor((m) => m.type === 'interrupt')
    const msg = await api(c, 'POST', `/api/agents/${agent.id}/message`, { text: 'Use vitest' })
    assert.equal(msg.body.delivered, true)
    await runner.waitFor((m) => m.type === 'user_message' && m.text === 'Use vitest')
    const patched = await api(c, 'PATCH', `/api/agents/${agent.id}`, { model: 'opus-5.5', rolePrompt: 'New prompt' })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.restartRequired, true)
    await runner.waitFor((m) => m.type === 'set_model' && m.model === 'opus-5.5')
    assert.equal(c.app.store.agents.get(agent.id)!.agent.model, 'opus-5.5')
    assert.equal((await api(c, 'PATCH', `/api/agents/${agent.id}`, { model: 'gpt-nope' })).status, 400)

    // restart: new token, rolePrompt + resumed session applied, old socket closed
    runner.send({ type: 'result', subtype: 'success', isError: false, sessionId: 'sess-123' })
    await waitUntil(() => c.app.store.agents.get(agent.id)!.sessionId === 'sess-123')
    const oldToken = c.infra.agents.get(agent.id)!.spec.env.COLONY_AGENT_TOKEN
    const closed = new Promise((r) => runner.ws.once('close', r))
    assert.equal((await api(c, 'POST', `/api/agents/${agent.id}/restart`)).status, 200)
    await closed
    const env = c.infra.agents.get(agent.id)!.spec.env
    assert.notEqual(env.COLONY_AGENT_TOKEN, oldToken)
    assert.equal(env.COLONY_SESSION_ID, 'sess-123')
    assert.equal(env.COLONY_MODEL, 'claude-opus-5-5')
    assert.equal(Buffer.from(env.COLONY_SYSTEM_PROMPT_B64, 'base64').toString(), 'New prompt')
    assert.equal(status(c, agent.id), 'booting')
    await assert.rejects(openRunner(c, oldToken), (e: any) => e.statusCode === 401)
    const r2 = await openRunner(c, env.COLONY_AGENT_TOKEN)
    r2.send({ type: 'hello', agentId: agent.id, sessionId: 'sess-123' })
    r2.send({ type: 'status', agentId: agent.id, status: 'idle' }) // real runners report status after hello
    await waitUntil(() => status(c, agent.id) === 'idle')
    r2.close()
  })

  test('messages to a disconnected agent are queued and delivered on hello', async () => {
    const { agent, token } = await spawn(c, project.id, { role: 'researcher' })
    const r = await api(c, 'POST', `/api/agents/${agent.id}/message`, { text: 'Compare epub libs' })
    assert.equal(r.body.queued, true)
    const runner = await openRunner(c, token)
    runner.send({ type: 'hello', agentId: agent.id })
    await runner.waitFor((m) => m.type === 'user_message' && m.text === 'Compare epub libs')
    runner.close()
  })

  test('kill removes the agent and its container', async () => {
    const { agent } = await spawn(c, project.id, { role: 'devops' })
    const r = await api(c, 'DELETE', `/api/agents/${agent.id}`)
    assert.equal(r.status, 200)
    assert.deepEqual(c.infra.callsTo('stopAgent').at(-1)!.args, [agent.id, { remove: true }])
    assert.ok(!c.app.store.agents.has(agent.id))
  })
})

describe('guards', () => {
  let c: Ctx
  let project: Project
  before(async () => { c = await setup(); project = await createProject(c, { name: 'Guarded', dailyCapUsd: 100 }) })
  after(() => teardown(c))

  test('budget cap pauses the agent and raises a budget alert', async () => {
    const ui = await openUi(c)
    const { agent, runner } = await spawnConnected(c, project.id, { role: 'backend', budgetCapUsd: 1 })
    runner.send({ type: 'usage', inputTokens: 10, outputTokens: 10, costUsd: 0.6 })
    runner.send({ type: 'usage', inputTokens: 10, outputTokens: 10, costUsd: 0.6 })
    await runner.waitFor((m) => m.type === 'pause')
    assert.equal(status(c, agent.id), 'paused')
    const al = await ui.waitFor((m) => m.type === 'alert' && m.alert.kind === 'budget' && m.alert.agentId === agent.id)
    assert.ok(al.type === 'alert')
    assert.equal(al.alert.severity, 'needs_you')
    // a further usage message does not raise a second alert
    runner.send({ type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0.1 })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal([...c.app.store.alerts.values()].filter((a) => a.kind === 'budget' && a.agentId === agent.id).length, 1)
    ui.close(); runner.close()
  })

  test('plan usage above pauseWorkersAtPct pauses workers but not the orchestrator', async () => {
    const orch = await spawnConnected(c, project.id, { role: 'orchestrator' })
    const worker = await spawnConnected(c, project.id, { role: 'frontend' })
    // the worker prompt names the orchestrator
    const prompt = Buffer.from(worker.env.COLONY_SYSTEM_PROMPT_B64, 'base64').toString()
    assert.ok(prompt.includes(orch.agent.callsign))
    assert.equal(orch.env.COLONY_MODEL, 'claude-opus-5-5')
    const resetsAt = new Date(Date.now() + 3600_000).toISOString()
    worker.runner.send({ type: 'plan_usage', usage: { session: { usedPct: 92, resetsAt, ratePctPerHour: 0 }, weekly: { usedPct: 40, resetsAt }, syncedAt: new Date().toISOString(), source: 'connected' } })
    await worker.runner.waitFor((m) => m.type === 'pause')
    assert.equal(status(c, worker.agent.id), 'paused')
    assert.notEqual(status(c, orch.agent.id), 'paused')
    assert.ok([...c.app.store.alerts.values()].some((a: Alert) => a.kind === 'limit_pace' && a.severity === 'critical'))
    orch.runner.close(); worker.runner.close()
  })

  test('only one orchestrator per project', async () => {
    const r = await api(c, 'POST', `/api/projects/${project.id}/agents`, { role: 'orchestrator' })
    assert.equal(r.status, 409)
  })
})

describe('merge requests', () => {
  let c: Ctx
  let project: Project
  before(async () => { c = await setup(); project = await createProject(c, { name: 'Mergeable' }) })
  after(() => teardown(c))

  test('merge refuses without approval; approve records the approval and merges once', async () => {
    const slug = c.app.store.projects.get(project.id)!.slug
    c.infra.setBranch(slug, 'agent/vex-07')
    const created = await api(c, 'POST', '/api/merge-requests', {
      projectId: project.id, branch: 'agent/vex-07', status: 'approved', approvedBy: 'you', approvedAt: new Date().toISOString(),
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.status, 'pending', 'approval fields cannot be set on create')
    assert.equal(created.body.approvedBy, undefined)
    assert.ok([...c.app.store.alerts.values()].some((a) => a.kind === 'approval' && !a.resolvedAt))

    await assert.rejects(c.app.merges.merge(created.body.id), (e: any) => e.statusCode === 403)
    assert.equal(c.infra.callsTo('mergeToMain').length, 0)

    const r = await api(c, 'POST', `/api/merge-requests/${created.body.id}/approve`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(c.infra.callsTo('mergeToMain').length, 1)
    assert.deepEqual(c.infra.callsTo('mergeToMain')[0].args.slice(0, 2), [slug, 'agent/vex-07'])
    assert.equal(r.body.mergeRequest.status, 'merged')
    assert.equal(r.body.mergeRequest.approvedBy, 'you')
    assert.ok(r.body.mergeRequest.approvedAt)
    assert.ok(c.app.store.alerts.get(`al-${created.body.id}`)!.resolvedAt)

    const again = await api(c, 'POST', `/api/merge-requests/${created.body.id}/approve`)
    assert.equal(again.status, 409)
    assert.equal(c.infra.callsTo('mergeToMain').length, 1)
  })

  test('a conflict raises an alert and returns 409', async () => {
    const slug = c.app.store.projects.get(project.id)!.slug
    c.infra.setBranch(slug, 'agent/kip-03', { conflict: true })
    const mr = (await api(c, 'POST', '/api/merge-requests', { projectId: project.id, branch: 'agent/kip-03' })).body
    const r = await api(c, 'POST', `/api/merge-requests/${mr.id}/approve`)
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'merge_conflict')
    assert.ok([...c.app.store.alerts.values()].some((a) => /conflict/i.test(a.title)))
  })

  test('branches and diff proxy the driver', async () => {
    const b = await api(c, 'GET', `/api/projects/${project.id}/branches`)
    assert.ok(b.body.some((x: any) => x.name === 'agent/vex-07'))
    const d = await api(c, 'GET', `/api/projects/${project.id}/diff?branch=agent/kip-03`)
    assert.equal(d.status, 200)
    assert.match(String(d.body), /diff --git/)
    assert.equal((await api(c, 'GET', `/api/projects/${project.id}/diff`)).status, 400)
  })
})

describe('security and resilience', () => {
  test('UI stream and REST reject non-local origins', async () => {
    const c = await setup()
    try {
      await assert.rejects(Client.open(`${c.wsBase}/api/stream`, { headers: { origin: 'http://evil.example' } }), (e: any) => e.statusCode === 403)
      const ok = await Client.open(`${c.wsBase}/api/stream`, { headers: { origin: 'http://localhost:5173' } })
      ok.close()
      const r = await api(c, 'GET', '/api/snapshot', undefined, { origin: 'http://evil.example' })
      assert.equal(r.status, 403)
    } finally { await teardown(c) }
  })

  test('admin token, when configured, is required', async () => {
    const c = await setup({ adminToken: 'admin-secret' })
    try {
      assert.equal((await api(c, 'GET', '/api/snapshot')).status, 401)
      assert.equal((await api(c, 'GET', '/api/snapshot', undefined, { authorization: 'Bearer admin-secret' })).status, 200)
      assert.equal((await api(c, 'GET', '/api/health')).status, 200)
      await assert.rejects(Client.open(`${c.wsBase}/api/stream`), (e: any) => e.statusCode === 401)
      ;(await Client.open(`${c.wsBase}/api/stream?token=admin-secret`)).close()
    } finally { await teardown(c) }
  })

  test('runner disconnect beyond the grace period marks the agent error and alerts', async () => {
    const c = await setup({ runnerGraceMs: 100 })
    try {
      const p = await createProject(c)
      const { agent, runner } = await spawnConnected(c, p.id)
      runner.close()
      await waitUntil(() => status(c, agent.id) === 'error', 2000)
      assert.ok([...c.app.store.alerts.values()].some((a) => a.kind === 'crash' && a.agentId === agent.id))
    } finally { await teardown(c) }
  })

  test('state survives a restart; reconcile adopts running containers and flags missing ones', async () => {
    const infra = createFakeDriver()
    const c1 = await setup({}, undefined, infra)
    const p = await createProject(c1)
    const kept = await spawnConnected(c1, p.id)
    const gone = await spawn(c1, p.id, { role: 'qa' })
    await c1.app.close()
    infra.agents.delete(gone.agent.id) // container vanished while we were down

    const c2 = await setup({}, c1.dir, infra)
    try {
      const snap = c2.app.store.snapshot()
      assert.equal(snap.projects.length, 1)
      assert.equal(snap.agents.length, 2)
      assert.equal(status(c2, gone.agent.id), 'error')
      assert.notEqual(status(c2, kept.agent.id), 'error')
      // the running agent's runner reconnects with its original token
      const r = await openRunner(c2, kept.token)
      r.send({ type: 'hello', agentId: kept.agent.id })
      await waitUntil(() => c2.app.store.connected.has(kept.agent.id))
      // stats poll → agent_delta with container stats
      const ui = await openUi(c2)
      await c2.app.stats.tick()
      const d = await ui.waitFor((m) => m.type === 'agent_delta' && m.agentId === kept.agent.id && m.patch.container !== undefined)
      assert.ok(d.type === 'agent_delta')
      assert.equal(d.patch.container!.memMb, 128)
      assert.equal(c2.app.store.resources().containers.running, 1)
      r.close(); ui.close()
    } finally { await teardown(c2) }
  })
})
