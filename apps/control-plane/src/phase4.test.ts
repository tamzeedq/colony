// Phase 4 (docs/phase4.md): dev Supabase per project, with FakeSupabase and the fake InfraDriver.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { Agent, Project, RunnerMessage, SupabaseDetails, SupabaseInfo } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT, type Config } from './config'
import { createFakeDriver, type FakeDriver } from './infra/fake'
import { FakeSupabase } from './infra/supabase-fake'
import {
  excludedServices, parseStatus, patchConfig, redact, setTomlKey, slotPorts,
} from './infra/supabase'
import { SupabaseService } from './supabase'

const OAUTH = 'sk-ant-oat-test-token-not-real'
const ADMIN = 'admin-secret-for-tests'

interface Ctx { app: ColonyApp; infra: FakeDriver; sb: FakeSupabase; base: string; wsBase: string; dir: string }

async function setup(over: Partial<Config> = {}, sb = new FakeSupabase()): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'colony-p4-'))
  const infra = createFakeDriver()
  const config = loadConfig({}, {
    dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
    oauthToken: OAUTH, adminToken: ADMIN, port: 0, bind: '127.0.0.1', ...over,
  })
  const app = await createApp({ config, infra, supabase: sb, poll: false, quiet: true })
  const port = await app.start(0, '127.0.0.1')
  return { app, infra, sb, dir, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` }
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

async function waitUntil(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function project(c: Ctx, body: Record<string, unknown> = {}) {
  const r = await api<Project>(c, 'POST', '/api/projects', { name: 'Readable', goal: 'Ship streaks', ...body })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}
const sbOf = (c: Ctx, id: string): SupabaseInfo => c.app.store.projects.get(id)!.project.supabase
const slugOf = (c: Ctx, id: string) => c.app.store.projects.get(id)!.slug

async function spawn(c: Ctx, projectId: string, role = 'backend') {
  const r = await api<Agent>(c, 'POST', `/api/projects/${projectId}/agents`, { role })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}
async function connect(c: Ctx, agentId: string) {
  const env = c.infra.agents.get(agentId)!.spec.env
  const ws = new WebSocket(`${c.wsBase}/api/runner`, { headers: { authorization: `Bearer ${env.COLONY_AGENT_TOKEN}` } })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  const send = (m: RunnerMessage) => ws.send(JSON.stringify(m))
  send({ type: 'hello', agentId, protocol: 1 })
  send({ type: 'status', agentId, status: 'idle' })
  await waitUntil(() => c.app.store.agents.get(agentId)!.agent.status !== 'booting')
  return { env, token: env.COLONY_AGENT_TOKEN, ws }
}
let rpcId = 1
async function call(c: Ctx, token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await api<any>(c, 'POST', '/mcp', { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }, `Bearer ${token}`)
  assert.equal(r.status, 200)
  const text: string = r.body.result.content[0].text
  let json: any
  try { json = JSON.parse(text) } catch { /* text */ }
  return { text, isError: !!r.body.result.isError, json }
}

// ── pure helpers ────────────────────────────────────────────────────────────────

describe('config and parsing helpers', () => {
  test('slot ports follow the 5432x layout', () => {
    assert.deepEqual(slotPorts(55300, 2), { shadow: 55320, api: 55321, db: 55322, studio: 55323, smtp: 55324, analytics: 55327, inspector: 55328, pooler: 55329 })
  })
  test('studio mode keeps studio and postgres-meta', () => {
    assert.ok(excludedServices(false).includes('studio'))
    assert.ok(!excludedServices(true).includes('studio'))
    assert.ok(!excludedServices(true).includes('postgres-meta'))
    assert.ok(excludedServices(true).includes('realtime'))
  })
  test('patchConfig sets project id, ports and turns off extras', () => {
    const toml = [
      '# header', 'project_id = "x"', '', '[api]', 'enabled = true', 'port = 54321', '', '[db]', 'port = 54322', 'shadow_port = 54320',
      '', '[db.pooler]', 'enabled = false', 'port = 54329', '', '[studio]', 'port = 54323', '', '[local_smtp]', 'enabled = true', 'port = 54324',
      '', '[edge_runtime]', 'enabled = true', 'inspector_port = 8083', '', '[analytics]', 'enabled = true', 'port = 54327', '',
    ].join('\n')
    const out = patchConfig(toml, 'readable', slotPorts(55300, 1))
    assert.match(out, /^project_id = "colony-readable"$/m)
    assert.match(out, /\[api\]\nenabled = true\nport = 55311/)
    assert.match(out, /\[db\]\nport = 55312\nshadow_port = 55310/)
    assert.match(out, /\[db\.pooler\]\nenabled = false\nport = 55319/)
    assert.match(out, /\[local_smtp\]\nenabled = false\nport = 55314/)
    assert.match(out, /\[edge_runtime\]\nenabled = false\ninspector_port = 55318/)
    assert.match(out, /\[analytics\]\nenabled = false\nport = 55317/)
    assert.equal(patchConfig(out, 'readable', slotPorts(55300, 1)), out, 'idempotent')
  })
  test('setTomlKey ignores commented keys and adds missing sections', () => {
    assert.equal(setTomlKey('[a]\n# port = 1\n', 'a', 'port', 2), '[a]\nport = 2\n# port = 1\n')
    assert.equal(setTomlKey('[a]\nx = 1', 'b', 'y', 'z'), '[a]\nx = 1\n\n[b]\ny = "z"')
  })
  test('parseStatus reads json and env output', () => {
    const json = JSON.stringify({ API_URL: 'http://127.0.0.1:55311', DB_URL: 'postgresql://postgres:postgres@127.0.0.1:55312/postgres', ANON_KEY: 'a', SERVICE_ROLE_KEY: 's', STUDIO_URL: 'http://127.0.0.1:55313' })
    assert.deepEqual(parseStatus(`Stopped services: [x]\n${json}\n`), { apiPort: 55311, dbPort: 55312, anonKey: 'a', serviceRoleKey: 's', studioPort: 55313 })
    assert.deepEqual(parseStatus('API_URL="http://127.0.0.1:1"\nDB_URL="postgresql://u:p@127.0.0.1:2/postgres"\nANON_KEY="a"\nSERVICE_ROLE_KEY="s"'), { apiPort: 1, dbPort: 2, anonKey: 'a', serviceRoleKey: 's' })
    assert.equal(parseStatus('nothing'), null)
  })
  test('redact strips JWTs and key values', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abcdefghijklmnop'
    const out = redact(`ANON_KEY=${jwt}\nfailed with ${jwt} sb_secret_abc123`)
    assert.ok(!out.includes(jwt) && !out.includes('sb_secret_abc123'), out)
  })
})

// ── lifecycle over HTTP ───────────────────────────────────────────────────────────

describe('provisioning and lifecycle', () => {
  let c: Ctx
  before(async () => { c = await setup() })
  after(() => teardown(c))

  test('a project without the toggle has no stack and refuses stop/reset', async () => {
    const p = await project(c, { name: 'Plain' })
    assert.equal(p.supabase.status, 'none')
    assert.equal((await api(c, 'POST', `/api/projects/${p.id}/supabase/stop`)).status, 409)
    assert.equal((await api(c, 'POST', `/api/projects/${p.id}/supabase/reset`, { confirm: true })).status, 409)
    assert.equal((await api(c, 'POST', `/api/projects/${p.id}/supabase/nuke`)).status, 400)
    const d = await api<SupabaseDetails>(c, 'GET', `/api/projects/${p.id}/supabase`)
    assert.equal(d.body.status, 'none')
    assert.deepEqual(d.body.migrations, [])
  })

  test('create with supabase:true provisions in the background on a free slot', async () => {
    let open!: () => void
    c.sb.gate = new Promise((r) => { open = r })
    c.sb.busySlots.add(0)
    const p = await project(c, { name: 'Streaks', supabase: true })
    assert.equal(p.supabase.status, 'provisioning')
    // A second start while provisioning conflicts.
    await waitUntil(() => c.sb.calls.some((x) => x.startsWith(`start ${slugOf(c, p.id)}`)))
    assert.equal((await api(c, 'POST', `/api/projects/${p.id}/supabase/stop`)).status, 409)
    open(); c.sb.gate = undefined
    await c.app.supabase.settled(p.id)
    const s = sbOf(c, p.id)
    assert.equal(s.status, 'running')
    assert.equal(s.slot, 1, 'slot 0 ports were busy')
    assert.equal(s.url, 'http://127.0.0.1:55311')
    assert.equal(s.dbUrl, 'postgresql://postgres:postgres@127.0.0.1:55312/postgres')
    assert.equal(s.studioUrl, undefined)
    // Keys stay out of the snapshot.
    const snap = await api(c, 'GET', '/api/snapshot')
    assert.ok(!JSON.stringify(snap.body).includes('service-test-key'))
  })

  test('slots are unique per project and reused by the same project', async () => {
    const a = await project(c, { name: 'Alpha', supabase: true })
    await c.app.supabase.settled(a.id)
    const used = [...c.app.store.projects.values()].map((r) => r.project.supabase.slot).filter((x) => x !== undefined)
    assert.equal(new Set(used).size, used.length)
    const slot = sbOf(c, a.id).slot
    assert.equal((await api(c, 'POST', `/api/projects/${a.id}/supabase/stop`)).status, 202)
    await c.app.supabase.settled(a.id)
    assert.equal(sbOf(c, a.id).status, 'stopped')
    assert.equal(sbOf(c, a.id).url, undefined)
    assert.equal((await api(c, 'POST', `/api/projects/${a.id}/supabase/start`)).status, 202)
    await c.app.supabase.settled(a.id)
    assert.equal(sbOf(c, a.id).slot, slot)
    assert.equal(sbOf(c, a.id).status, 'running')
  })

  test('reset needs confirm, wipes and restarts', async () => {
    const p = await project(c, { name: 'Wipe', supabase: true })
    await c.app.supabase.settled(p.id)
    const slug = slugOf(c, p.id)
    c.sb.stacks.get(slug)!.migrations.push({ version: '20261110000000', name: 'init' })
    const d = await api<SupabaseDetails>(c, 'GET', `/api/projects/${p.id}/supabase`)
    assert.deepEqual(d.body.migrations, [{ version: '20261110000000', name: 'init' }])
    assert.equal(sbOf(c, p.id).migration, '20261110000000')
    assert.equal((await api(c, 'POST', `/api/projects/${p.id}/supabase/reset`)).status, 400)
    assert.equal((await api(c, 'POST', `/api/projects/${p.id}/supabase/reset`, { confirm: true })).status, 202)
    await c.app.supabase.settled(p.id)
    assert.ok(c.sb.calls.includes(`stop ${slug} wipe`))
    assert.equal(sbOf(c, p.id).status, 'running')
    assert.equal(sbOf(c, p.id).migration, undefined)
  })

  test('studio toggle restarts a running stack with studio', async () => {
    const p = await project(c, { name: 'Studio', supabase: true })
    await c.app.supabase.settled(p.id)
    assert.equal((await api(c, 'PATCH', `/api/projects/${p.id}/supabase`, { studio: 'yes' })).status, 400)
    assert.equal((await api(c, 'PATCH', `/api/projects/${p.id}/supabase`, { other: true })).status, 400)
    const r = await api<SupabaseInfo>(c, 'PATCH', `/api/projects/${p.id}/supabase`, { studio: true })
    assert.equal(r.status, 200)
    await c.app.supabase.settled(p.id)
    const s = sbOf(c, p.id)
    assert.equal(s.studio, true)
    assert.equal(s.studioUrl, `http://127.0.0.1:${slotPorts(55300, s.slot!).studio}`)
    assert.ok(c.sb.calls.at(-1)!.endsWith('studio=true'))
  })

  test('a failed start sets error and raises an alert; a retry clears both', async () => {
    c.sb.failNextStart = 'port is already allocated'
    const p = await project(c, { name: 'Broken', supabase: true })
    await c.app.supabase.settled(p.id)
    assert.equal(sbOf(c, p.id).status, 'error')
    assert.match(sbOf(c, p.id).error!, /already allocated/)
    const alert = c.app.store.alerts.get(`al-supabase-${p.id}`)!
    assert.ok(alert && !alert.resolvedAt)
    await api(c, 'POST', `/api/projects/${p.id}/supabase/start`)
    await c.app.supabase.settled(p.id)
    assert.equal(sbOf(c, p.id).status, 'running')
    assert.equal(sbOf(c, p.id).error, undefined)
    assert.ok(c.app.store.alerts.get(`al-supabase-${p.id}`)!.resolvedAt)
  })

  test('deleting a project removes its stack first (purge wipes data)', async () => {
    const p = await project(c, { name: 'Gone', supabase: true })
    await c.app.supabase.settled(p.id)
    const slug = slugOf(c, p.id)
    assert.equal((await api(c, 'DELETE', `/api/projects/${p.id}?purge=1`)).status, 200)
    assert.ok(c.sb.calls.includes(`remove ${slug} purge`))
    assert.ok(!c.sb.stacks.has(slug))
  })
})

// ── agents: env, prompt, MCP tools, activity ──────────────────────────────────────

describe('agents and the dev backend', () => {
  let c: Ctx
  before(async () => { c = await setup() })
  after(() => teardown(c))

  test('agents in a provisioned base get env vars and the Dev backend prompt', async () => {
    const p = await project(c, { supabase: true })
    await c.app.supabase.settled(p.id)
    const a = await spawn(c, p.id)
    const env = c.infra.agents.get(a.id)!.spec.env
    assert.equal(env.SUPABASE_URL, 'http://supabase-kong:8000')
    assert.equal(env.DATABASE_URL, 'postgresql://postgres:postgres@supabase-db:5432/postgres')
    assert.equal(env.SUPABASE_ANON_KEY, 'anon-test-key')
    assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, 'service-test-key')
    const prompt = Buffer.from(env.COLONY_SYSTEM_PROMPT_B64, 'base64').toString('utf8')
    assert.match(prompt, /## Dev backend/)
    assert.match(prompt, /supabase db push --db-url "\$DATABASE_URL"/)
    // The stored role prompt (editable by the commander) is unchanged.
    assert.doesNotMatch(c.app.store.agents.get(a.id)!.agent.rolePrompt, /Dev backend/)
  })

  test('agents in a base without a stack get neither', async () => {
    const p = await project(c, { name: 'NoDb' })
    const a = await spawn(c, p.id)
    const env = c.infra.agents.get(a.id)!.spec.env
    assert.equal(env.SUPABASE_URL, undefined)
    assert.doesNotMatch(Buffer.from(env.COLONY_SYSTEM_PROMPT_B64, 'base64').toString('utf8'), /Dev backend/)
    const m = await connect(c, a.id)
    const r = await call(c, m.token, 'get_backend')
    assert.equal(r.json.status, 'none')
    assert.equal(r.json.env, null)
    const l = await call(c, m.token, 'list_migrations')
    assert.ok(l.isError)
    m.ws.close()
  })

  test('MCP tools: get_backend, list_migrations, gen_types', async () => {
    const p = await project(c, { name: 'Tools', supabase: true })
    await c.app.supabase.settled(p.id)
    c.sb.stacks.get(slugOf(c, p.id))!.migrations.push({ version: '1', name: 'create_todos' })
    const a = await spawn(c, p.id)
    const m = await connect(c, a.id)
    const b = await call(c, m.token, 'get_backend')
    assert.equal(b.json.status, 'running')
    assert.equal(b.json.env.SUPABASE_URL, 'http://supabase-kong:8000')
    assert.equal(b.json.hostApiUrl, sbOf(c, p.id).url)
    const l = await call(c, m.token, 'list_migrations')
    assert.deepEqual(l.json.migrations, [{ version: '1', name: 'create_todos' }])
    const t = await call(c, m.token, 'gen_types')
    assert.equal(t.isError, false)
    assert.match(t.text, /export type Database/)
    m.ws.close()
  })

  test('spawning an agent starts a stopped stack', async () => {
    const p = await project(c, { name: 'Sleepy', supabase: true })
    await c.app.supabase.settled(p.id)
    await api(c, 'POST', `/api/projects/${p.id}/supabase/stop`)
    await c.app.supabase.settled(p.id)
    assert.equal(sbOf(c, p.id).status, 'stopped')
    const a = await spawn(c, p.id)
    // Env is still injected while the stack starts (in-network URLs and known keys).
    assert.equal(c.infra.agents.get(a.id)!.spec.env.SUPABASE_ANON_KEY, 'anon-test-key')
    await c.app.supabase.settled(p.id)
    assert.equal(sbOf(c, p.id).status, 'running')
  })

  test('the orchestrator is told when the stack is running', async () => {
    const p = await project(c, { name: 'Told' })
    const o = await spawn(c, p.id, 'orchestrator')
    const m = await connect(c, o.id)
    const got: string[] = []
    m.ws.on('message', (d) => { const x = JSON.parse(d.toString()); if (x.type === 'user_message') got.push(x.text) })
    await api(c, 'POST', `/api/projects/${p.id}/supabase/start`)
    await c.app.supabase.settled(p.id)
    await waitUntil(() => got.some((t) => /dev Supabase for this base is running/.test(t)))
    m.ws.close()
  })
})

// ── idle stop and reconcile (service level, injected clock) ──────────────────────────

describe('idle stop and reconcile', () => {
  test('stops a running stack after the idle window with no live agents', async () => {
    const c = await setup({ supabaseIdleMs: 60_000 })
    try {
      const p = await project(c, { supabase: true })
      await c.app.supabase.settled(p.id)
      let now = 1_000_000
      const svc = new SupabaseService(c.app.store, c.app.db, c.sb, { supabaseBasePort: 55300, supabaseIdleMs: 60_000, supabaseStartTimeoutMs: 1000 }, { info() {}, warn() {} }, () => now)
      await svc.tick()                       // idle clock starts
      now += 30_000; await svc.tick()
      assert.equal(sbOf(c, p.id).status, 'running')
      now += 31_000; await svc.tick()
      await svc.settled(p.id)
      assert.equal(sbOf(c, p.id).status, 'stopped')

      // A live agent keeps it up.
      await svc.start(p.id); await svc.settled(p.id)
      await spawn(c, p.id)
      now += 10 * 60_000; await svc.tick(); now += 10 * 60_000; await svc.tick()
      assert.equal(sbOf(c, p.id).status, 'running')
    } finally { await teardown(c) }
  })

  test('reconcile marks stacks that are gone as stopped and re-reads running ones', async () => {
    const c = await setup()
    try {
      const a = await project(c, { name: 'Up', supabase: true })
      const b = await project(c, { name: 'Down', supabase: true })
      await c.app.supabase.settled(a.id); await c.app.supabase.settled(b.id)
      await c.sb.stop(slugOf(c, b.id))       // stopped behind Colony's back (e.g. Docker restart)
      c.app.store.projects.get(a.id)!.project.supabase.url = 'stale'
      await c.app.supabase.reconcile()
      assert.equal(sbOf(c, a.id).status, 'running')
      assert.equal(sbOf(c, a.id).url, 'http://127.0.0.1:' + slotPorts(55300, sbOf(c, a.id).slot!).api)
      assert.equal(sbOf(c, b.id).status, 'stopped')
    } finally { await teardown(c) }
  })
})
