// Phase 6 (docs/phase6.md): surviving restarts, checkpoints and revert. Fake InfraDriver.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { Agent, Project, RunnerMessage } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT, type Config } from './config'
import { createFakeDriver, type FakeDriver } from './infra/fake'
import { parseBranchLog } from './infra/docker'

const OAUTH = 'sk-ant-oat-test-token-not-real'
const ADMIN = 'admin-secret-for-tests'

interface Ctx { app: ColonyApp; infra: FakeDriver; base: string; wsBase: string; dir: string }

async function setup(over: Partial<Config> = {}, dir = mkdtempSync(join(tmpdir(), 'colony-p6-')), infra = createFakeDriver()): Promise<Ctx> {
  const config = loadConfig({}, {
    dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
    oauthToken: OAUTH, adminToken: ADMIN, port: 0, bind: '127.0.0.1', ...over,
  })
  const app = await createApp({ config, infra, poll: false, quiet: true })
  const port = await app.start(0, '127.0.0.1')
  return { app, infra, dir, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` }
}
async function teardown(c: Ctx) { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }) }

async function api<T = any>(c: Ctx, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { authorization: `Bearer ${ADMIN}` }
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(c.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* plain */ }
  return { status: res.status, body: parsed as T }
}
async function waitUntil(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
async function project(c: Ctx) {
  const r = await api<Project>(c, 'POST', '/api/projects', { name: 'Readable', goal: 'Ship streaks' })
  assert.equal(r.status, 201)
  return r.body
}
async function spawn(c: Ctx, projectId: string, role = 'backend') {
  const r = await api<Agent>(c, 'POST', `/api/projects/${projectId}/agents`, { role })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}
async function connect(c: Ctx, agentId: string, status: 'idle' | 'running' = 'idle') {
  const env = c.infra.agents.get(agentId)!.spec.env
  const ws = new WebSocket(`${c.wsBase}/api/runner`, { headers: { authorization: `Bearer ${env.COLONY_AGENT_TOKEN}` } })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  const got: string[] = []
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'user_message') got.push(m.text) })
  const send = (m: RunnerMessage) => ws.send(JSON.stringify(m))
  send({ type: 'hello', agentId, protocol: 1 })
  send({ type: 'status', agentId, status })
  await waitUntil(() => c.app.store.agents.get(agentId)!.agent.status === status)
  return { ws, got, send }
}
const status = (c: Ctx, id: string) => c.app.store.agents.get(id)?.agent.status
const sha = (n: number) => n.toString(16).padStart(40, 'a')

// ── restarts ─────────────────────────────────────────────────────────────────────

describe('surviving restarts', () => {
  test('agent env keeps the Claude session on the workspace volume', async () => {
    const c = await setup()
    try {
      const p = await project(c)
      const a = await spawn(c, p.id)
      assert.equal(c.infra.agents.get(a.id)!.spec.env.CLAUDE_CONFIG_DIR, '/workspace/.colony/claude')
    } finally { await teardown(c) }
  })

  test('boot ensures git servers and resumes agents whose containers vanished', async () => {
    const infra = createFakeDriver()
    const c1 = await setup({}, undefined, infra)
    const p = await project(c1)
    const kept = await spawn(c1, p.id)
    const gone = await spawn(c1, p.id, 'qa')
    const paused = await spawn(c1, p.id, 'frontend')
    await api(c1, 'POST', `/api/agents/${paused.id}/pause`)
    const sessionBefore = c1.app.store.agents.get(gone.id)!.sessionId
    await c1.app.close()
    infra.agents.delete(gone.id)       // Docker restarted: containers gone, volumes kept
    infra.agents.delete(paused.id)
    const ensuresBefore = infra.callsTo('ensureProject').length

    const c2 = await setup({}, c1.dir, infra)
    try {
      assert.ok(infra.callsTo('ensureProject').length > ensuresBefore, 'git server ensured on boot')
      assert.equal(status(c2, gone.id), 'booting')
      assert.ok(infra.agents.get(gone.id), 'container recreated')
      assert.equal(c2.app.store.agents.get(gone.id)!.sessionId, sessionBefore)
      const alert = [...c2.app.store.alerts.values()].find((x) => x.agentId === gone.id)!
      assert.equal(alert.severity, 'heads_up')
      assert.match(alert.title, /resumed after restart/)
      // A paused agent is not meant to run: it is flagged, not resumed.
      assert.equal(status(c2, paused.id), 'error')
      assert.notEqual(status(c2, kept.id), 'error')
    } finally { await teardown(c2) }
  })

  test('Docker coming back re-runs reconcile', async () => {
    const c = await setup()
    try {
      await project(c)
      const n0 = c.infra.callsTo('ensureProject').length
      c.infra.setPing(false)
      await c.app.stats.tick()
      c.infra.setPing(true)
      await c.app.stats.tick()
      assert.ok(c.infra.callsTo('ensureProject').length > n0)
      await c.app.stats.tick()
      const n1 = c.infra.callsTo('ensureProject').length
      await c.app.stats.tick()
      assert.equal(c.infra.callsTo('ensureProject').length, n1, 'only on the down → up edge')
    } finally { await teardown(c) }
  })
})

// ── checkpoints and revert ──────────────────────────────────────────────────────────

describe('checkpoints and revert', () => {
  const history = () => [
    { sha: sha(4), subject: 'wip: break things', at: '2026-11-11T10:04:00Z' },
    { sha: sha(3), subject: 'add tests', at: '2026-11-11T10:03:00Z' },
    { sha: sha(2), subject: 'add streak api', at: '2026-11-11T10:02:00Z' },
    { sha: sha(1), subject: 'Initial commit', at: '2026-11-11T10:00:00Z', inMain: true },
    { sha: sha(0), subject: 'older main', at: '2026-11-11T09:00:00Z', inMain: true },
  ]

  async function world() {
    const c = await setup()
    const p = await project(c)
    const a = await spawn(c, p.id)
    const slug = c.app.store.projects.get(p.id)!.slug
    c.infra.setBranch(slug, a.branch!, { commits: history(), aheadOfMain: 3 })
    const execs: string[][] = []
    c.infra.execHandler = (_id, cmd) => { execs.push(cmd); return { exitCode: 0, stdout: '', stderr: '' } }
    return { c, p, a, slug, execs }
  }

  test('commits, manual checkpoint, revert by count with backup, sync and message', async () => {
    const { c, a, slug, execs } = await world()
    try {
      const r0 = await api(c, 'GET', `/api/agents/${a.id}/commits`)
      assert.equal(r0.status, 200)
      assert.equal(r0.body.commits.length, 5)
      assert.equal(r0.body.commits[3].inMain, true)

      const cp = await api(c, 'POST', `/api/agents/${a.id}/checkpoints`, { label: 'Before the risky bit' })
      assert.equal(cp.status, 201)
      assert.equal(cp.body.sha, sha(4))
      const r1 = await api(c, 'GET', `/api/agents/${a.id}/commits`)
      assert.equal(r1.body.commits[0].checkpoint, 'Before the risky bit')

      const m = await connect(c, a.id)
      const mainBefore = c.infra.projects.get(slug)!.mainSha
      const rv = await api(c, 'POST', `/api/agents/${a.id}/revert`, { count: 1 })
      assert.equal(rv.status, 200, JSON.stringify(rv.body))
      assert.equal(rv.body.from, sha(4))
      assert.equal(rv.body.to, sha(3))
      assert.equal(rv.body.workspaceSynced, true)
      const branch = c.infra.projects.get(slug)!.branches.get(a.branch!)!
      assert.equal(branch.sha, sha(3))
      assert.equal(c.infra.projects.get(slug)!.refs.get(rv.body.backupRef), sha(4))
      assert.equal(c.infra.projects.get(slug)!.mainSha, mainBefore, 'main untouched')
      assert.ok(execs.some((cmd) => cmd.join(' ').includes('git reset --quiet --hard')))
      await waitUntil(() => m.got.some((t) => /reverted your branch/.test(t)))
      m.ws.close()
    } finally { await teardown(c) }
  })

  test('guards: busy agent, bad input, non-ancestor, older than main', async () => {
    const { c, a } = await world()
    try {
      const m = await connect(c, a.id, 'running')
      assert.equal((await api(c, 'POST', `/api/agents/${a.id}/revert`, { count: 1 })).status, 409)
      assert.equal((await api(c, 'POST', `/api/agents/${a.id}/revert`, { count: 1, force: true })).status, 200)
      m.send({ type: 'status', agentId: a.id, status: 'idle' })
      await waitUntil(() => status(c, a.id) === 'idle')
      assert.equal((await api(c, 'POST', `/api/agents/${a.id}/revert`, {})).status, 400)
      assert.equal((await api(c, 'POST', `/api/agents/${a.id}/revert`, { to: 'abc' })).status, 400)
      assert.equal((await api(c, 'POST', `/api/agents/${a.id}/revert`, { count: 1, other: 1 })).status, 400)
      assert.equal((await api(c, 'POST', `/api/agents/${a.id}/revert`, { to: sha(99) })).status, 409, 'not on the branch')
      assert.equal((await api(c, 'POST', `/api/agents/${a.id}/revert`, { to: sha(0) })).status, 409, 'older than where it left main')
      assert.equal((await api(c, 'POST', `/api/agents/${a.id}/revert`, { count: 40 })).status, 409, 'not that many commits')
      m.ws.close()
    } finally { await teardown(c) }
  })

  test('undo restores the backup even though it is not an ancestor', async () => {
    const { c, a, slug } = await world()
    try {
      const rv = await api(c, 'POST', `/api/agents/${a.id}/revert`, { to: sha(2) })
      assert.equal(rv.status, 200)
      const list = await api(c, 'GET', `/api/agents/${a.id}/commits`)
      assert.equal(list.body.lastBackup.sha, sha(4))
      const undo = await api(c, 'POST', `/api/agents/${a.id}/revert`, { to: sha(4) })
      assert.equal(undo.status, 200, JSON.stringify(undo.body))
      assert.equal(undo.body.undo, true)
      assert.equal(c.infra.projects.get(slug)!.branches.get(a.branch!)!.sha, sha(4))
      const after = await api(c, 'GET', `/api/agents/${a.id}/commits`)
      assert.equal(after.body.commits.length, 5)
    } finally { await teardown(c) }
  })

  test('completing a quest records a checkpoint automatically', async () => {
    const { c, p, a, slug } = await world()
    try {
      const q = c.app.quests.create(p.id, { title: 'Streak API', acceptance: ['works'] }, 'you')
      c.app.quests.assign(q.id, a.id, p.id)
      await c.app.quests.complete(q.id, c.app.store.agents.get(a.id)!, 'done')
      await waitUntil(() => [...c.infra.projects.get(slug)!.refs.keys()].some((r) => r.startsWith(`refs/colony/checkpoints/${a.id}/`)))
      const list = await api(c, 'GET', `/api/agents/${a.id}/commits`)
      assert.match(list.body.commits[0].checkpoint, /Quest "Streak API" completed/)
    } finally { await teardown(c) }
  })

  test('parseBranchLog reads the git script output', () => {
    const out = `${sha(2)}\t1762855320\t0\tadd streak api\n${sha(1)}\t1762855200\t1\tInitial\tcommit\n\ngarbage\n`
    assert.deepEqual(parseBranchLog(out), [
      { sha: sha(2), at: new Date(1762855320_000).toISOString(), inMain: false, subject: 'add streak api' },
      { sha: sha(1), at: new Date(1762855200_000).toISOString(), inMain: true, subject: 'Initial\tcommit' },
    ])
  })
})
