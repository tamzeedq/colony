// Pause controls (feedback #18): workers-only pause-all, pauseRequested until the runner reports
// paused, and the admin-only shutdown endpoint.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { Agent, Project, RunnerMessage } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT } from './config'
import { createFakeDriver, type FakeDriver } from './infra/fake'

const ADMIN = 'admin-secret-for-tests'

interface Ctx { app: ColonyApp; infra: FakeDriver; base: string; wsBase: string; dir: string; exits: number }

async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'colony-pause-'))
  const infra = createFakeDriver()
  const config = loadConfig({}, {
    dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
    oauthToken: 'sk-ant-oat-test-token-not-real', adminToken: ADMIN, port: 0, bind: '127.0.0.1',
  })
  const c = { infra, dir, exits: 0 } as Ctx
  c.app = await createApp({ config, infra, poll: false, quiet: true, onShutdown: () => { c.exits++ } })
  const port = await c.app.start(0, '127.0.0.1')
  c.base = `http://127.0.0.1:${port}`
  c.wsBase = `ws://127.0.0.1:${port}`
  return c
}
async function teardown(c: Ctx) { await c.app.close().catch(() => {}); rmSync(c.dir, { recursive: true, force: true }) }

async function api<T = any>(c: Ctx, method: string, path: string, body?: unknown, auth = true) {
  const h: Record<string, string> = auth ? { authorization: `Bearer ${ADMIN}` } : {}
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(c.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* plain */ }
  return { status: res.status, body: parsed as T }
}
async function waitUntil(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
async function connect(c: Ctx, role: string, projectId: string) {
  const r = await api<Agent>(c, 'POST', `/api/projects/${projectId}/agents`, { role })
  assert.equal(r.status, 201)
  const id = r.body.id
  const env = c.infra.agents.get(id)!.spec.env
  const ws = new WebSocket(`${c.wsBase}/api/runner`, { headers: { authorization: `Bearer ${env.COLONY_AGENT_TOKEN}` } })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  const got: string[] = []
  ws.on('message', (d) => { got.push(JSON.parse(d.toString()).type) })
  const send = (m: RunnerMessage) => ws.send(JSON.stringify(m))
  send({ type: 'hello', agentId: id, protocol: 1 })
  send({ type: 'status', agentId: id, status: 'running' })
  await waitUntil(() => c.app.store.agents.get(id)!.agent.status === 'running')
  return { id, ws, got, send }
}
const agentOf = (c: Ctx, id: string) => c.app.store.toAgent(c.app.store.agents.get(id)!)

describe('pause controls', () => {
  test('pause-all workersOnly leaves orchestrators running; pauseRequested holds until the runner reports paused', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Pausey', goal: 'Pause things' })).body
      const orch = await connect(c, 'orchestrator', p.id)
      const w1 = await connect(c, 'backend', p.id)
      const w2 = await connect(c, 'qa', p.id)

      assert.equal((await api(c, 'POST', '/api/agents/pause-all', { nope: 1 })).status, 400)
      const r = await api<{ paused: string[]; skipped: string[] }>(c, 'POST', '/api/agents/pause-all', { workersOnly: true })
      assert.equal(r.status, 200)
      assert.deepEqual(r.body.paused.sort(), [w1.id, w2.id].sort())
      await waitUntil(() => w1.got.includes('pause') && w2.got.includes('pause'))
      assert.ok(!orch.got.includes('pause'))
      assert.equal(agentOf(c, orch.id).pauseRequested, undefined)

      // requested, not yet reported
      assert.equal(agentOf(c, w1.id).status, 'running')
      assert.equal(agentOf(c, w1.id).pauseRequested, true)
      assert.equal(agentOf(c, w1.id).pausedBy, 'you')

      w1.send({ type: 'status', agentId: w1.id, status: 'paused' })
      await waitUntil(() => agentOf(c, w1.id).status === 'paused')
      assert.equal(agentOf(c, w1.id).pauseRequested, undefined)
      assert.equal(agentOf(c, w2.id).pauseRequested, true)

      // a full pause-all then also asks the orchestrator
      const all = await api<{ paused: string[] }>(c, 'POST', '/api/agents/pause-all')
      assert.deepEqual(all.body.paused, [orch.id])

      // resume clears the request
      await api(c, 'POST', `/api/agents/${w2.id}/resume`)
      assert.equal(agentOf(c, w2.id).pauseRequested, undefined)
      assert.equal(agentOf(c, w2.id).pausedBy, undefined)
      for (const x of [orch, w1, w2]) x.ws.close()
    } finally { await teardown(c) }
  })

  test('POST /api/admin/shutdown needs the admin token, answers 202, then closes and calls onShutdown', async () => {
    const c = await setup()
    try {
      assert.equal((await api(c, 'POST', '/api/admin/shutdown', undefined, false)).status, 401)
      await new Promise((r) => setTimeout(r, 400))
      assert.equal(c.exits, 0)
      const r = await api(c, 'POST', '/api/admin/shutdown')
      assert.equal(r.status, 202)
      await waitUntil(() => c.exits === 1)
    } finally { await teardown(c) }
  })
})
