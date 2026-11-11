// Phase 3 (docs/phase3.md): Colony MCP server, quests, team flow, guardrails.
// Same style as server.test.ts: in-memory InfraDriver fake, temp SQLite DB, real HTTP/WS on port 0.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { ActivityEvent, Agent, Project, Quest, RunnerCommand, RunnerMessage } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT, type Config } from './config'
import { createFakeDriver, type FakeDriver } from './infra/fake'
import { LoopDetector } from './loops'

const OAUTH = 'sk-ant-oat-test-token-not-real'
const ADMIN = 'admin-secret-for-tests'

interface Ctx { app: ColonyApp; infra: FakeDriver; base: string; wsBase: string; dir: string }

async function setup(over: Partial<Config> = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'colony-p3-'))
  const infra = createFakeDriver()
  const config = loadConfig({}, {
    dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
    oauthToken: OAUTH, adminToken: ADMIN, port: 0, bind: '127.0.0.1', ...over,
  })
  const app = await createApp({ config, infra, poll: false, quiet: true })
  const port = await app.start(0, '127.0.0.1')
  return { app, infra, dir, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` }
}
async function teardown(c: Ctx) { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }) }

async function api<T = any>(c: Ctx, method: string, path: string, body?: unknown, auth = `Bearer ${ADMIN}`) {
  const h: Record<string, string> = auth ? { authorization: auth } : {}
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(c.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* plain */ }
  return { status: res.status, body: parsed as T }
}

class Runner {
  readonly cmds: RunnerCommand[] = []
  constructor(readonly ws: WebSocket) { ws.on('message', (d) => this.cmds.push(JSON.parse(d.toString()))) }
  static open(c: Ctx, token: string) {
    return new Promise<Runner>((resolve, reject) => {
      const ws = new WebSocket(`${c.wsBase}/api/runner`, { headers: { authorization: `Bearer ${token}` } })
      const r = new Runner(ws)
      ws.once('open', () => resolve(r))
      ws.once('error', reject)
    })
  }
  send(m: RunnerMessage) { this.ws.send(JSON.stringify(m)) }
  texts() { return this.cmds.filter((m): m is Extract<RunnerCommand, { type: 'user_message' }> => m.type === 'user_message').map((m) => m.text) }
  close() { this.ws.close() }
}

async function waitUntil(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function project(c: Ctx, name = 'Readable', goal = 'Ship streaks') {
  const r = await api<Project>(c, 'POST', '/api/projects', { name, goal })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}

interface Member { agent: Agent; token: string; env: Record<string, string>; runner: Runner }

async function member(c: Ctx, projectId: string, body: Record<string, unknown>): Promise<Member> {
  const r = await api<Agent>(c, 'POST', `/api/projects/${projectId}/agents`, body)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return connect(c, r.body.id)
}
async function connect(c: Ctx, agentId: string): Promise<Member> {
  const env = c.infra.agents.get(agentId)!.spec.env
  const runner = await Runner.open(c, env.COLONY_AGENT_TOKEN)
  runner.send({ type: 'hello', agentId, protocol: 1 })
  runner.send({ type: 'status', agentId, status: 'idle' })
  await waitUntil(() => c.app.store.agents.get(agentId)!.agent.status !== 'booting')
  return { agent: c.app.store.toAgent(c.app.store.agents.get(agentId)!), token: env.COLONY_AGENT_TOKEN, env, runner }
}

let rpcId = 1
async function rpc(c: Ctx, token: string, method: string, params?: unknown) {
  return api<any>(c, 'POST', '/mcp', { jsonrpc: '2.0', id: rpcId++, method, params }, `Bearer ${token}`)
}
/** Call a tool; returns { text, isError, json }. */
async function call(c: Ctx, m: Member, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(c, m.token, 'tools/call', { name, arguments: args })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  if (r.body.error) return { text: r.body.error.message as string, isError: true, json: undefined as any, rpcError: true }
  const text: string = r.body.result.content[0].text
  let json: any
  try { json = JSON.parse(text) } catch { /* text */ }
  return { text, isError: !!r.body.result.isError, json, rpcError: false }
}
const slugOf = (c: Ctx, projectId: string) => c.app.store.projects.get(projectId)!.slug

// ── MCP transport & auth ───────────────────────────────────────────────────────

describe('MCP transport', () => {
  let c: Ctx, p: Project, orch: Member
  before(async () => { c = await setup(); p = await project(c); orch = await member(c, p.id, { role: 'orchestrator' }) })
  after(async () => { orch.runner.close(); await teardown(c) })

  test('agent env carries an MCP config pointing at /mcp with its own token', () => {
    const cfg = JSON.parse(Buffer.from(orch.env.COLONY_MCP_CONFIG_B64, 'base64').toString('utf8'))
    assert.equal(cfg.mcpServers.colony.type, 'http')
    assert.match(cfg.mcpServers.colony.url, /^http:\/\/host\.docker\.internal:\d+\/mcp$/)
    assert.equal(cfg.mcpServers.colony.headers.Authorization, `Bearer ${orch.token}`)
  })

  test('rejects no token, a wrong token and the admin token', async () => {
    assert.equal((await api(c, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, '')).status, 401)
    assert.equal((await api(c, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, 'Bearer nope')).status, 401)
    assert.equal((await api(c, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
  })

  test('initialize echoes the protocol version; notifications get 202; GET is 405', async () => {
    const init = await rpc(c, orch.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    assert.equal(init.body.result.protocolVersion, '2025-06-18')
    assert.ok(init.body.result.capabilities.tools)
    const note = await api(c, 'POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, `Bearer ${orch.token}`)
    assert.equal(note.status, 202)
    assert.equal((await api(c, 'GET', '/mcp', undefined, `Bearer ${orch.token}`)).status, 405)
    const batch = await api<any[]>(c, 'POST', '/mcp', [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }], `Bearer ${orch.token}`)
    assert.deepEqual(batch.body.map((r) => r.id), ['a'])
    assert.equal((await rpc(c, orch.token, 'resources/list')).body.error.code, -32601)
  })

  test('tools depend on the role, and nobody gets a merge tool', async () => {
    const worker = await member(c, p.id, { role: 'backend' })
    const names = async (m: Member) => ((await rpc(c, m.token, 'tools/list')).body.result.tools as { name: string }[]).map((t) => t.name).sort()
    const o = await names(orch), w = await names(worker)
    for (const t of ['create_task', 'spawn_agent', 'assign_task', 'message_agent', 'review_branch', 'request_merge', 'stop_agent', 'request_human']) assert.ok(o.includes(t), t)
    for (const t of ['report_progress', 'complete_task', 'ask_orchestrator', 'request_human']) assert.ok(w.includes(t), t)
    assert.ok(!o.includes('complete_task') && !w.includes('spawn_agent'))
    assert.ok(![...o, ...w].some((t) => /merge/.test(t) && t !== 'request_merge'))
    const denied = await call(c, worker, 'spawn_agent', { role: 'qa' })
    assert.ok(denied.rpcError && /unknown tool/.test(denied.text))
    worker.runner.close()
  })
})

// ── the team flow ────────────────────────────────────────────────────────────

describe('quest flow: plan → staff → complete → review → merge', () => {
  let c: Ctx, p: Project, orch: Member, worker: Member
  let q1: string, q2: string
  before(async () => { c = await setup(); p = await project(c) })
  after(async () => { orch?.runner.close(); worker?.runner.close(); await teardown(c) })

  test('a new orchestrator gets the kickoff as its first message', async () => {
    orch = await member(c, p.id, { role: 'orchestrator' })
    await waitUntil(() => orch.runner.texts().length > 0)
    assert.match(orch.runner.texts()[0], /Kickoff/)
    assert.match(orch.runner.texts()[0], /Ship streaks/)
    assert.match(orch.runner.texts()[0], /request_human/)
  })

  test('create_task makes quests with dependencies; cycles are refused', async () => {
    const a = await call(c, orch, 'create_task', { title: 'Streaks table', brief: 'Own db/', acceptance: ['migration applies', 'npm test passes'] })
    assert.equal(a.isError, false, a.text)
    q1 = a.json.id
    const b = await call(c, orch, 'create_task', { title: 'Streaks API', brief: 'Own api/', acceptance: ['GET /streaks'], depends_on: [q1], priority: 'high' })
    q2 = b.json.id
    assert.deepEqual(c.app.store.quests.get(q2)!.dependsOn, [q1])
    assert.equal(c.app.store.quests.get(q2)!.createdBy, orch.agent.id)
    const cyc = await call(c, orch, 'update_task', { quest_id: q1, depends_on: [q2] })
    assert.ok(cyc.isError && /cycle/.test(cyc.text))
    const missing = await call(c, orch, 'create_task', { title: 'x', brief: 'y', acceptance: [], depends_on: ['q-nope'] })
    assert.ok(missing.isError)
  })

  test('spawn_agent with a quest boots a worker that receives the brief', async () => {
    const r = await call(c, orch, 'spawn_agent', { role: 'backend', model: 'haiku-5.5', quest_id: q1 })
    assert.equal(r.isError, false, r.text)
    assert.equal(r.json.agent.model, 'haiku-5.5')
    assert.equal(c.app.store.quests.get(q1)!.status, 'in_progress')
    worker = await connect(c, r.json.agent.id)
    await waitUntil(() => worker.runner.texts().some((t) => t.includes(q1)))
    const brief = worker.runner.texts().find((t) => t.includes(q1))!
    assert.match(brief, /Streaks table/)
    assert.match(brief, /migration applies/)
    assert.match(brief, /complete_task/)
    assert.ok(c.app.store.recentEvents(50).some((e) => e.kind === 'handoff' && e.agentId === worker.agent.id))
    const orchSpawn = await call(c, orch, 'spawn_agent', { role: 'orchestrator' })
    assert.ok(orchSpawn.isError)
  })

  test('a quest with unmet dependencies is held as blocked', async () => {
    const r = await call(c, orch, 'assign_task', { quest_id: q2, agent_id: worker.agent.callsign })
    assert.equal(r.json.sent, false)
    assert.deepEqual(r.json.waitingOn, [q1])
    assert.equal(c.app.store.quests.get(q2)!.status, 'blocked')
    assert.ok(!worker.runner.texts().some((t) => t.includes(q2)))
  })

  test('complete_task refuses until the branch is pushed, then hands back to the orchestrator', async () => {
    const early = await call(c, worker, 'complete_task', { quest_id: q1, summary: 'done' })
    assert.ok(early.isError && /git push/.test(early.text))
    c.infra.setBranch(slugOf(c, p.id), worker.agent.branch!, { aheadOfMain: 2, diff: 'diff --git a/db/streaks.sql b/db/streaks.sql\n+create table streaks();\n' })
    const prog = await call(c, worker, 'report_progress', { text: 'Migration written', quest_id: q1, acceptance_done: [0] })
    assert.equal(prog.isError, false)
    assert.equal(c.app.store.quests.get(q1)!.acceptance[0].done, true)
    const done = await call(c, worker, 'complete_task', { quest_id: q1, summary: 'Added the streaks table; tests pass' })
    assert.equal(done.isError, false, done.text)
    assert.equal(c.app.store.quests.get(q1)!.status, 'in_review')
    await waitUntil(() => orch.runner.texts().some((t) => t.includes('completed quest') && t.includes(q1)))
    const wrong = await call(c, worker, 'complete_task', { quest_id: q2, summary: 'x' })
    assert.ok(wrong.isError)
  })

  test('review_branch shows the diff; request_merge opens one approval with the summary', async () => {
    const rev = await call(c, orch, 'review_branch', { quest_id: q1 })
    assert.match(rev.text, /2 commit\(s\) ahead/)
    assert.match(rev.text, /create table streaks/)
    const mr1 = await call(c, orch, 'request_merge', { quest_id: q1, summary: 'Streaks table. Verified: npm test.' })
    assert.equal(mr1.isError, false, mr1.text)
    const mr = mr1.json.mergeRequest
    assert.equal(mr.questId, q1)
    assert.equal(mr.summary, 'Streaks table. Verified: npm test.')
    assert.equal(mr.approvedBy, undefined)
    const alert = c.app.store.alerts.get(`al-${mr.id}`)!
    assert.equal(alert.detail, 'Streaks table. Verified: npm test.')
    const again = await call(c, orch, 'request_merge', { quest_id: q1, summary: 'again' })
    assert.equal(again.json.mergeRequest.id, mr.id)
  })

  test('the commander approves: quest done, XP, the blocked quest starts, everyone is told', async () => {
    const mr = [...c.app.store.mergeRequests.values()][0]
    const r = await api(c, 'POST', `/api/merge-requests/${mr.id}/approve`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(c.app.store.quests.get(q1)!.status, 'done')
    assert.ok(c.app.store.quests.get(q1)!.acceptance.every((a) => a.done))
    assert.equal(c.app.store.agents.get(worker.agent.id)!.agent.questsDone, 1)
    assert.ok(c.app.store.recentEvents(80).some((e) => e.kind === 'quest_complete'))
    assert.equal(c.app.store.quests.get(q2)!.status, 'in_progress')
    await waitUntil(() => worker.runner.texts().some((t) => t.includes(q2) && t.includes('Streaks API')))
    await waitUntil(() => orch.runner.texts().some((t) => t.includes('merged') && t.includes(q1)))
  })

  test('request changes sends the quest back; a conflict asks for a fix quest', async () => {
    const slug = slugOf(c, p.id)
    c.infra.setBranch(slug, worker.agent.branch!, { aheadOfMain: 1 })
    await call(c, worker, 'complete_task', { quest_id: q2, summary: 'API done' })
    const mr = (await call(c, orch, 'request_merge', { quest_id: q2, summary: 'API' })).json.mergeRequest
    await api(c, 'POST', `/api/merge-requests/${mr.id}/request-changes`, { note: 'Add pagination' })
    assert.equal(c.app.store.quests.get(q2)!.status, 'in_progress')
    await waitUntil(() => worker.runner.texts().some((t) => t.includes('Add pagination')))

    c.infra.setBranch(slug, worker.agent.branch!, { aheadOfMain: 1, conflict: true })
    await call(c, worker, 'complete_task', { quest_id: q2, summary: 'pagination added' })
    const mr2 = (await call(c, orch, 'request_merge', { quest_id: q2, summary: 'API v2' })).json.mergeRequest
    assert.equal((await api(c, 'POST', `/api/merge-requests/${mr2.id}/approve`)).status, 409)
    await waitUntil(() => orch.runner.texts().some((t) => /conflict/.test(t) && /fix quest/.test(t)))
  })

  test('commander quests and cancellations reach the team', async () => {
    const created = await api<Quest>(c, 'POST', `/api/projects/${p.id}/quests`, { title: 'Dark mode', priority: 'low', acceptance: ['toggle persists'] })
    assert.equal(created.status, 201)
    assert.equal(created.body.createdBy, 'you')
    await waitUntil(() => orch.runner.texts().some((t) => t.includes('Dark mode')))
    const cancel = await api<Quest>(c, 'PATCH', `/api/quests/${q2}`, { status: 'failed' })
    assert.equal(cancel.body.status, 'failed')
    await waitUntil(() => worker.runner.texts().some((t) => t.includes('cancelled') && t.includes(q2)))
    assert.equal((await api(c, 'PATCH', `/api/quests/${q2}`, { status: 'nope' })).status, 400)
  })

  test('message_agent, ask_orchestrator and request_human', async () => {
    await call(c, orch, 'message_agent', { agent_id: worker.agent.id, text: 'Use zod' })
    await waitUntil(() => worker.runner.texts().some((t) => t.includes('Use zod') && t.includes('(orchestrator)')))
    await call(c, worker, 'ask_orchestrator', { text: 'Which table name?' })
    await waitUntil(() => orch.runner.texts().some((t) => t.includes('asks] Which table name?')))
    const q = await call(c, orch, 'request_human', { question: 'Approve the plan?', options: ['Approve plan', 'Change it'] })
    const alert = c.app.store.alerts.get(q.json.alertId)!
    assert.equal(alert.kind, 'question')
    assert.deepEqual(alert.actions.map((a) => a.id).slice(0, 2), ['reply:Approve plan', 'reply:Change it'])
  })

  test('stop_agent returns open quests to the backlog and refuses to stop itself', async () => {
    const q3 = (await call(c, orch, 'create_task', { title: 'Docs', brief: 'README', acceptance: [] })).json.id
    await call(c, orch, 'assign_task', { quest_id: q3, agent_id: worker.agent.id })
    assert.ok((await call(c, orch, 'stop_agent', { agent_id: orch.agent.id })).isError)
    const r = await call(c, orch, 'stop_agent', { agent_id: worker.agent.id })
    assert.equal(r.isError, false, r.text)
    assert.equal(c.app.store.agents.has(worker.agent.id), false)
    assert.equal(c.app.store.quests.get(q3)!.status, 'backlog')
    assert.equal(c.app.store.quests.get(q3)!.assigneeId, undefined)
  })
})

// ── isolation & guardrails ───────────────────────────────────────────────────

describe('isolation and guardrails', () => {
  let c: Ctx
  before(async () => { c = await setup({ maxAgentsPerProject: 2 }) })
  after(() => teardown(c))

  test('tools cannot reach another project', async () => {
    const a = await project(c, 'Alpha', ''), b = await project(c, 'Beta', '')
    const orchA = await member(c, a.id, { role: 'orchestrator' })
    const workerB = await member(c, b.id, { role: 'backend' })
    const qB = (await api<Quest>(c, 'POST', `/api/projects/${b.id}/quests`, { title: 'B only' })).body
    assert.ok((await call(c, orchA, 'message_agent', { agent_id: workerB.agent.id, text: 'hi' })).isError)
    assert.ok((await call(c, orchA, 'assign_task', { quest_id: qB.id, agent_id: workerB.agent.id })).isError)
    assert.ok((await call(c, orchA, 'stop_agent', { agent_id: workerB.agent.id })).isError)
    assert.ok((await call(c, orchA, 'update_task', { quest_id: qB.id, status: 'failed' })).isError)
    const listed = await call(c, orchA, 'list_tasks')
    assert.deepEqual(listed.json, [])
    assert.ok(!workerB.runner.texts().some((t) => t.includes('hi')))
    orchA.runner.close(); workerB.runner.close()
  })

  test('at most maxAgentsPerProject agents per base', async () => {
    const p = await project(c, 'Gamma', '')
    const orch = await member(c, p.id, { role: 'orchestrator' })
    assert.equal((await call(c, orch, 'spawn_agent', { role: 'qa' })).isError, false)
    const third = await call(c, orch, 'spawn_agent', { role: 'qa' })
    assert.ok(third.isError && /limit 2/.test(third.text))
    orch.runner.close()
  })

  test('loop detector: repeated commands and stalls raise loop alerts and tell the orchestrator', async () => {
    const p = await project(c, 'Delta', '')
    const orch = await member(c, p.id, { role: 'orchestrator' })
    const w = await member(c, p.id, { role: 'backend' })
    for (let i = 0; i < 6; i++) {
      const ev: ActivityEvent = { id: `ev-loop-${i}`, at: new Date().toISOString(), agentId: w.agent.id, projectId: p.id, kind: 'command', text: 'npm test', command: { cmd: 'npm test', exitCode: 1 } }
      w.runner.send({ type: 'event', event: ev })
      if (i === 0) w.runner.send({ type: 'event', event: ev }) // same id again (upsert) counts once
    }
    await waitUntil(() => [...c.app.store.alerts.values()].some((a) => a.kind === 'loop' && a.agentId === w.agent.id))
    await waitUntil(() => orch.runner.texts().some((t) => t.includes('Loop detector')))
    assert.equal([...c.app.store.alerts.values()].filter((a) => a.kind === 'loop').length, 1)

    let now = 1_000_000
    const det = new LoopDetector(c.app.store, c.app.quests, { stallMs: 60_000, now: () => now })
    c.app.store.patchAgent(w.agent.id, { status: 'running' })
    det.checkStalls()
    now += 61_000
    det.checkStalls()
    assert.ok([...c.app.store.alerts.values()].some((a) => a.kind === 'loop' && /no progress/.test(a.title)))
    orch.runner.close(); w.runner.close()
  })
})
