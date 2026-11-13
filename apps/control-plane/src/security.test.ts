// Feedback items 6 (secrets guardrails), 14 (Supabase Storage switch) and 16 (keep-awake).

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { scanDiffForSecrets, secretFileRisk, secretKinds, type ActivityEvent, type Agent, type KeepAwakeState, type Project, type RunnerMessage, type SupabaseInfo } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT, type Config } from './config'
import { createFakeDriver, type FakeDriver } from './infra/fake'
import { excludedServices } from './infra/supabase'
import { FakeSupabase } from './infra/supabase-fake'
import { helperCommand, KeepAwake, type HeldProcess, type Spawner } from './keepawake'
import { buildTools } from './mcp'
import { describeFindings, MASK, redactEvent, redactText, scanDiff } from './redact'

const OAUTH = 'sk-ant-oat-test-token-not-real-0123456789'
const ADMIN = 'admin-secret-for-tests-0123456789'
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24ifQ.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

// ── pure: patterns, redaction, diff scan ─────────────────────────────────────────

describe('secret patterns and redaction', () => {
  test('secret-shaped strings are masked; ordinary code is not', () => {
    const cases = [
      `printf 'EXPO_PUBLIC_SUPABASE_ANON_KEY=${JWT}' > .env`,
      'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'git remote add origin https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r',
      'token github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'SUPABASE_SECRET=sb_secret_abcdefghijklmnop',
      'aws AKIAIOSFODNN7EXAMPLE',
      'DB_PASSWORD=hunter2hunter2',
    ]
    for (const c of cases) {
      const out = redactText(c)
      assert.ok(out.includes(MASK), `not masked: ${c} → ${out}`)
      assert.doesNotMatch(out, /eyJhbGci|sk-ant-api03|ghp_abc|github_pat_11|sb_secret_abc|AKIAIOSFODNN7EXAMPLE|hunter2hunter2/)
    }
    for (const c of ['const token = getToken()', 'SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY', 'API_KEY=your-api-key-here', 'npm test -- streaks', 'const KEY = process.env.SUPABASE_ANON_KEY']) {
      assert.equal(redactText(c), c, c)
    }
  })

  test('private key blocks are masked across lines', () => {
    const out = redactText('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc\nxyz\n-----END RSA PRIVATE KEY-----\nafter')
    assert.doesNotMatch(out, /MIIEow|xyz/)
    assert.match(out, /after$/)
  })

  test('known values are masked even when not secret-shaped', () => {
    assert.equal(redactText('key is anon-test-key!', ['anon-test-key']), `key is ${MASK}!`)
    assert.equal(redactText('short', ['abc']), 'short') // too short to treat as a secret
  })

  test('redactEvent scrubs text and every payload field', () => {
    const ev: ActivityEvent = {
      id: 'e1', at: new Date().toISOString(), agentId: 'a', projectId: 'p', kind: 'command',
      text: `echo ${JWT}`,
      command: { cmd: `echo ${JWT}`, outputTail: `ok ${JWT}` },
      edit: { path: '.env', added: 1, removed: 0, hunk: `+KEY=${JWT}` },
      message: { to: 'b', body: `use ${JWT}` },
      tool: { name: 'Read', target: `x ${JWT}` },
    }
    const out = redactEvent(ev)
    assert.doesNotMatch(JSON.stringify(out), /eyJhbGci/)
    assert.equal(out.id, 'e1')
    const clean: ActivityEvent = { id: 'e2', at: ev.at, agentId: 'a', projectId: 'p', kind: 'thought', text: 'hello' }
    assert.equal(redactEvent(clean), clean)
  })

  test('file risk: .env* (not .env.example), keys and certificates', () => {
    assert.equal(secretFileRisk('.env')?.level, 'block')
    assert.equal(secretFileRisk('apps/web/.env.local')?.level, 'block')
    assert.equal(secretFileRisk('.env.production')?.level, 'block')
    assert.equal(secretFileRisk('.env.example'), undefined)
    assert.equal(secretFileRisk('certs/server.pem')?.level, 'block')
    assert.equal(secretFileRisk('deploy.key')?.level, 'block')
    assert.equal(secretFileRisk('config/secrets.ts')?.level, 'warn')
    assert.equal(secretFileRisk('src/env.ts'), undefined)
    assert.deepEqual(secretKinds('nothing here'), [])
  })

  test('diff scan: added secret files and lines, with masked previews; deletions are fine', () => {
    const diff = [
      'diff --git a/.env b/.env', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/.env', '@@ -0,0 +1 @@', `+SUPABASE_ANON_KEY=${JWT}`,
      'diff --git a/.env.example b/.env.example', '--- /dev/null', '+++ b/.env.example', '@@ -0,0 +1 @@', '+SUPABASE_ANON_KEY=your-anon-key',
      'diff --git a/old.pem b/old.pem', 'deleted file mode 100644', '--- a/old.pem', '+++ /dev/null', '@@ -1 +0,0 @@', '-----BEGIN PRIVATE KEY-----',
      'diff --git a/src/client.ts b/src/client.ts', '--- a/src/client.ts', '+++ b/src/client.ts', '@@ -10,2 +10,3 @@', ' import x', `+const key = '${JWT}'`, ' export {}',
    ].join('\n')
    const r = scanDiffForSecrets(diff)
    assert.deepEqual(r.files.map((f) => f.path), ['.env'])
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].path, 'src/client.ts')
    assert.equal(r.lines[0].line, 11)
    assert.doesNotMatch(r.lines[0].preview!, /eyJhbGci/)
    const s = scanDiff(diff)
    assert.equal(s.ok, false)
    assert.match(describeFindings(s), /\.env: env file/)
    assert.match(describeFindings(s), /src\/client\.ts:11: JWT/)
    assert.equal(scanDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n').ok, true)
  })
})

// ── the control plane ────────────────────────────────────────────────────────────

interface Ctx { app: ColonyApp; infra: FakeDriver; sb: FakeSupabase; base: string; wsBase: string; dir: string; printed: string[]; config: Config }

async function setup(over: Partial<Config> = {}, keepAwake?: { spawner: Spawner; platform?: NodeJS.Platform }): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'colony-sec-'))
  const infra = createFakeDriver()
  const sb = new FakeSupabase()
  const config = loadConfig({}, {
    dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
    oauthToken: OAUTH, adminToken: ADMIN, port: 0, bind: '127.0.0.1', ...over,
  })
  const printed: string[] = []
  const app = await createApp({ config, infra, supabase: sb, poll: false, quiet: true, print: (l) => printed.push(l), ...(keepAwake ? { keepAwake } : {}) })
  const port = await app.start(0, '127.0.0.1')
  return { app, infra, sb, dir, printed, config, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` }
}
async function teardown(c: Ctx) { await c.app.close(); rmSync(c.dir, { recursive: true, force: true }) }

async function api<T = any>(c: Ctx, method: string, path: string, body?: unknown, token = c.config.adminToken) {
  const h: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(c.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* plain */ }
  return { status: res.status, body: parsed as T, text }
}

async function waitUntil(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function project(c: Ctx, body: Record<string, unknown> = {}) {
  const r = await api<Project>(c, 'POST', '/api/projects', { name: 'Vault', goal: 'Keep secrets', ...body })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}
async function spawn(c: Ctx, projectId: string, role: string) {
  const r = await api<Agent>(c, 'POST', `/api/projects/${projectId}/agents`, { role })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}
const sbOf = (c: Ctx, id: string): SupabaseInfo => c.app.store.projects.get(id)!.project.supabase
const slugOf = (c: Ctx, id: string) => c.app.store.projects.get(id)!.slug
const tool = (c: Ctx, name: string) => buildTools({ store: c.app.store, agents: c.app.agents, quests: c.app.quests, merges: c.app.merges, infra: c.infra, supabase: c.app.supabase }).find((t) => t.name === name)!

describe('redaction on ingest', () => {
  let c: Ctx
  before(async () => { c = await setup() })
  after(() => teardown(c))

  test('runner events are stored, broadcast and shown on the card without secrets', async () => {
    const p = await project(c, { supabase: true })
    await c.app.supabase.settled(p.id)
    const a = await spawn(c, p.id, 'frontend')
    const env = c.infra.agents.get(a.id)!.spec.env
    const seen: string[] = []
    const off = c.app.store.subscribe((m) => seen.push(JSON.stringify(m)))
    const ws = new WebSocket(`${c.wsBase}/api/runner`, { headers: { authorization: `Bearer ${env.COLONY_AGENT_TOKEN}` } })
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
    const send = (m: RunnerMessage) => ws.send(JSON.stringify(m))
    send({ type: 'hello', agentId: a.id, protocol: 1 })
    const cmd = `printf 'URL=x\\nANON=anon-test-key\\nTOKEN=${OAUTH}\\nJWT=${JWT}' > .env.local`
    send({ type: 'event', event: { id: 'ev-1', at: new Date().toISOString(), agentId: a.id, projectId: p.id, kind: 'command', text: cmd, command: { cmd, running: true, outputTail: `wrote ${JWT}` } } })
    await waitUntil(() => c.app.store.agentEvents(a.id, 10).some((e) => e.id === 'ev-1'))
    const stored = c.app.store.agentEvents(a.id, 10).find((e) => e.id === 'ev-1')!
    const all = JSON.stringify(stored) + seen.join('\n') + JSON.stringify(c.app.store.agents.get(a.id)!.agent)
    for (const secret of ['anon-test-key', OAUTH, 'eyJhbGci']) assert.ok(!all.includes(secret), `leaked ${secret.slice(0, 12)}`)
    assert.match(stored.command!.cmd, /\[redacted\]/)
    assert.match(c.app.store.agents.get(a.id)!.agent.currentAction ?? '', /\[redacted\]/)
    off()
    ws.close()
  })
})

describe('narrowed keys and the merge guard', () => {
  let c: Ctx
  before(async () => { c = await setup() })
  after(() => teardown(c))

  test('only backend/devops/orchestrator/custom get the service-role key (env and get_backend)', async () => {
    const p = await project(c, { name: 'Keys', supabase: true })
    await c.app.supabase.settled(p.id)
    const fe = await spawn(c, p.id, 'frontend')
    const be = await spawn(c, p.id, 'backend')
    const feEnv = c.infra.agents.get(fe.id)!.spec.env
    const beEnv = c.infra.agents.get(be.id)!.spec.env
    assert.equal(feEnv.SUPABASE_ANON_KEY, 'anon-test-key')
    assert.equal(feEnv.SUPABASE_SERVICE_ROLE_KEY, undefined)
    assert.equal(beEnv.SUPABASE_SERVICE_ROLE_KEY, 'service-test-key')
    assert.match(Buffer.from(feEnv.COLONY_SYSTEM_PROMPT_B64, 'base64').toString('utf8'), /service-role key is kept for backend roles/)
    const get = tool(c, 'get_backend')
    const feB = await get.run({}, c.app.store.agents.get(fe.id)!) as { env: Record<string, string> }
    const beB = await get.run({}, c.app.store.agents.get(be.id)!) as { env: Record<string, string> }
    assert.equal(feB.env.SUPABASE_SERVICE_ROLE_KEY, undefined)
    assert.equal(beB.env.SUPABASE_SERVICE_ROLE_KEY, 'service-test-key')
  })

  test('request_merge refuses branches that add .env files or secret-shaped lines', async () => {
    const p = await project(c, { name: 'Guard' })
    const orch = await spawn(c, p.id, 'orchestrator')
    const me = c.app.store.agents.get(orch.id)!
    const q = c.app.quests.create(p.id, { title: 'Login', brief: 'auth', acceptance: [] }, orch.id)
    const slug = slugOf(c, p.id)
    c.infra.setBranch(slug, 'agent/leaky', {
      diff: ['diff --git a/.env b/.env', '--- /dev/null', '+++ b/.env', '@@ -0,0 +1 @@', `+SUPABASE_ANON_KEY=${JWT}`].join('\n'),
    })
    const rm = tool(c, 'request_merge')
    await assert.rejects(async () => rm.run({ quest_id: q.id, summary: 'x', branch: 'agent/leaky' }, me), (e: Error) => {
      assert.match(e.message, /Refused/)
      assert.match(e.message, /\.env: env file/)
      assert.match(e.message, /\.env\.local/)
      assert.doesNotMatch(e.message, /eyJhbGci/)
      return true
    })
    c.infra.setBranch(slug, 'agent/inline', {
      diff: ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1,2 @@', ' x', `+const k = '${JWT}'`].join('\n'),
    })
    await assert.rejects(async () => rm.run({ quest_id: q.id, summary: 'x', branch: 'agent/inline' }, me), /src\/a\.ts:2: JWT/)
    const review = await tool(c, 'review_branch').run({ branch: 'agent/inline' }, me) as string
    assert.match(review, /WARNING: it adds secrets/)
    assert.equal([...c.app.store.mergeRequests.values()].length, 0)
    c.infra.setBranch(slug, 'agent/clean', {
      diff: ['diff --git a/.env.example b/.env.example', '--- /dev/null', '+++ b/.env.example', '@@ -0,0 +1 @@', '+SUPABASE_ANON_KEY=your-anon-key'].join('\n'),
    })
    const ok = await rm.run({ quest_id: q.id, summary: 'x', branch: 'agent/clean' }, me) as { mergeRequest: { id: string } }
    assert.ok(ok.mergeRequest.id)
  })

  test('a flagged merge the commander approved blocks GitHub publish until acknowledged', async () => {
    const p = await project(c, { name: 'Pub' })
    const slug = slugOf(c, p.id)
    c.infra.setBranch(slug, 'agent/flagged', {
      diff: ['diff --git a/server.pem b/server.pem', '--- /dev/null', '+++ b/server.pem', '@@ -0,0 +1 @@', '+-----BEGIN PRIVATE KEY-----'].join('\n'),
    })
    const mr = c.app.merges.create({ projectId: p.id, branch: 'agent/flagged' })
    await c.app.merges.approve(mr.id)
    assert.equal(c.app.store.mergeRequests.get(mr.id)!.status, 'merged')
    assert.equal((await api(c, 'PUT', '/api/github/token', { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123' })).status, 200)
    assert.equal((await api(c, 'PATCH', `/api/projects/${p.id}/github`, { repo: 'octo/pub', mode: 'push' })).status, 200)
    const r = await api(c, 'POST', `/api/projects/${p.id}/github/publish`)
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'secrets_found')
    assert.match(r.body.error.message, /server\.pem/)
    assert.equal(c.infra.callsTo('pushToRemote').length, 0)
    assert.equal((await api(c, 'POST', `/api/projects/${p.id}/github/publish`, { acknowledgeSecrets: 'yes' })).status, 400)
    await api(c, 'POST', `/api/projects/${p.id}/github/publish`, { acknowledgeSecrets: true })
    assert.equal(c.infra.callsTo('pushToRemote').length, 1)
  })
})

describe('admin token rotation', () => {
  let c: Ctx
  before(async () => { c = await setup() })
  after(() => teardown(c))

  test('rotates on disk and in memory, prints the link to stdout only, never returns the token', async () => {
    const r = await api(c, 'POST', '/api/admin/rotate-token')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.match(r.body.pairingHint, /pairing link/)
    const token = readFileSync(join(c.dir, 'admin-token'), 'utf8').trim()
    assert.equal(token.length, 64)
    assert.ok(!r.text.includes(token))
    assert.equal(c.printed.length, 1)
    assert.ok(c.printed[0].includes(`#pair=${token}`))
    assert.equal((await api(c, 'GET', '/api/snapshot', undefined, ADMIN)).status, 401)
    assert.equal((await api(c, 'GET', '/api/snapshot', undefined, token)).status, 200)
  })
})

describe('Supabase Storage switch', () => {
  let c: Ctx
  before(async () => { c = await setup() })
  after(() => teardown(c))

  test('excludedServices keeps storage-api when storage is on; imgproxy stays out', () => {
    assert.ok(!excludedServices(false).includes('storage-api'))
    assert.ok(excludedServices(false).includes('imgproxy'))
    assert.ok(excludedServices(false, false).includes('storage-api'))
    assert.ok(!excludedServices(true, true).includes('studio'))
  })

  test('new stacks run storage; the prompt and get_backend say so', async () => {
    const p = await project(c, { name: 'Photos', supabase: true })
    await c.app.supabase.settled(p.id)
    assert.equal(sbOf(c, p.id).storage, true)
    assert.match(c.sb.calls.at(-1)!, /storage=true$/)
    const a = await spawn(c, p.id, 'backend')
    const prompt = Buffer.from(c.infra.agents.get(a.id)!.spec.env.COLONY_SYSTEM_PROMPT_B64, 'base64').toString('utf8')
    assert.match(prompt, /Storage at \/storage\/v1/)
    const b = await tool(c, 'get_backend').run({}, c.app.store.agents.get(a.id)!) as { storage: boolean; storageUrl: string }
    assert.equal(b.storage, true)
    assert.equal(b.storageUrl, 'http://supabase-kong:8000/storage/v1')
  })

  test('PATCH {storage:false} restarts a running stack without storage; validation', async () => {
    const p = await project(c, { name: 'NoFiles', supabase: true })
    await c.app.supabase.settled(p.id)
    assert.equal((await api(c, 'PATCH', `/api/projects/${p.id}/supabase`, { storage: 'no' })).status, 400)
    assert.equal((await api(c, 'PATCH', `/api/projects/${p.id}/supabase`, {})).status, 400)
    const r = await api<SupabaseInfo>(c, 'PATCH', `/api/projects/${p.id}/supabase`, { storage: false })
    assert.equal(r.status, 200)
    await c.app.supabase.settled(p.id)
    assert.equal(sbOf(c, p.id).storage, false)
    assert.equal(sbOf(c, p.id).status, 'running')
    assert.match(c.sb.calls.at(-1)!, /studio=false storage=false$/)
    const a = await spawn(c, p.id, 'frontend')
    assert.match(Buffer.from(c.infra.agents.get(a.id)!.spec.env.COLONY_SYSTEM_PROMPT_B64, 'base64').toString('utf8'), /Storage is \*\*off\*\*/)
    const b = await tool(c, 'get_backend').run({}, c.app.store.agents.get(a.id)!) as { storage: boolean }
    assert.equal(b.storage, false)
  })

  test('an older provisioned stack without the field counts as storage on', async () => {
    const p = await project(c, { name: 'Legacy', supabase: true })
    await c.app.supabase.settled(p.id)
    const rec = c.app.store.projects.get(p.id)!
    const { storage: _s, ...rest } = rec.project.supabase
    rec.project = { ...rec.project, supabase: rest }
    await api(c, 'POST', `/api/projects/${p.id}/supabase/stop`)
    await c.app.supabase.settled(p.id)
    await api(c, 'POST', `/api/projects/${p.id}/supabase/start`)
    await c.app.supabase.settled(p.id)
    assert.match(c.sb.calls.at(-1)!, /storage=true$/)
    // Turning it "on" explicitly records the choice without a restart.
    const n = c.sb.calls.length
    await api(c, 'PATCH', `/api/projects/${p.id}/supabase`, { storage: true })
    assert.equal(sbOf(c, p.id).storage, true)
    assert.equal(c.sb.calls.length, n)
  })
})

// ── keep-awake ──────────────────────────────────────────────────────────────────

class FakeHelper implements HeldProcess {
  killed = false
  private cb?: (code: number | null, error?: Error) => void
  kill() { this.killed = true }
  onExit(cb: (code: number | null, error?: Error) => void) { this.cb = cb }
  exit(code: number | null, error?: Error) { this.cb?.(code, error) }
}

describe('keep-awake', () => {
  test('helper commands per platform watch the control plane pid', () => {
    const w = helperCommand('win32', 4242)!
    assert.equal(w.cmd, 'powershell.exe')
    const script = Buffer.from(w.args.at(-1)!, 'base64').toString('utf16le')
    assert.match(script, /SetThreadExecutionState/)
    assert.match(script, /2147483649/) // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, no display flag
    assert.match(script, /Get-Process -Id 4242/)
    assert.doesNotMatch(script, /powercfg/)
    assert.deepEqual(helperCommand('darwin', 7), { cmd: 'caffeinate', args: ['-i', '-w', '7'] })
    const l = helperCommand('linux', 9)!
    assert.equal(l.cmd, 'systemd-inhibit')
    assert.ok(l.args.includes('--what=sleep'))
    assert.match(l.args.at(-1)!, /kill -0 9/)
    assert.equal(helperCommand('aix', 1), undefined)
  })

  test('modes: off, working (with a 3 min release delay) and always', async () => {
    const helpers: FakeHelper[] = []
    const spawned: string[] = []
    const spawner: Spawner = (cmd) => { spawned.push(cmd); const h = new FakeHelper(); helpers.push(h); return h }
    const c = await setup({}, { spawner, platform: 'darwin' })
    try {
      let t = 1_000_000
      const ka = new KeepAwake(c.app.store, c.app.db, { spawner, platform: 'darwin', now: () => t })
      assert.deepEqual(ka.state(), { mode: 'off', active: false, reason: 'Off' })
      ka.setMode('working')
      assert.equal(ka.active, false)
      assert.equal(ka.state().reason, 'No agents working')

      const p = await project(c, { name: 'Awake' })
      const a = await spawn(c, p.id, 'backend') // booting counts as working
      ka.evaluate()
      assert.equal(ka.active, true)
      assert.equal(spawned.length, 1)
      assert.equal(ka.state().reason, '1 agent working')

      c.app.store.patchAgent(a.id, { status: 'idle' })
      t += 60_000
      ka.evaluate()
      assert.equal(ka.active, true)
      assert.match(ka.state().reason, /releasing in 2 min/)
      t += 2 * 60_000 + 1
      ka.evaluate()
      assert.equal(ka.active, false)
      assert.equal(helpers[0].killed, true)

      ka.setMode('always')
      assert.equal(ka.active, true)
      assert.equal(ka.state().reason, 'Always while Colony runs')
      // The helper dying on its own is respawned while still wanted.
      helpers[1].exit(0)
      assert.equal(ka.active, true)
      assert.equal(spawned.length, 3)
      ka.setMode('off')
      assert.equal(ka.active, false)
      assert.equal(helpers[2].killed, true)
      ka.stop()
    } finally { await teardown(c) }
  })

  test('a missing helper reports unsupported instead of looping', async () => {
    const c = await setup()
    try {
      const h = new FakeHelper()
      let n = 0
      const ka = new KeepAwake(c.app.store, c.app.db, { spawner: () => { n++; return h }, platform: 'linux' })
      ka.setMode('always')
      h.exit(null, new Error('spawn systemd-inhibit ENOENT'))
      assert.equal(n, 1)
      const s = ka.state()
      assert.equal(s.active, false)
      assert.equal(s.unsupported, true)
      assert.match(s.reason, /ENOENT/)
      const none = new KeepAwake(c.app.store, c.app.db, { spawner: () => h, platform: 'aix' })
      assert.equal(none.state().unsupported, true)
    } finally { await teardown(c) }
  })

  test('GET/PUT /api/keep-awake and resources.keepAwake in the snapshot', async () => {
    const helpers: FakeHelper[] = []
    const c = await setup({}, { spawner: () => { const h = new FakeHelper(); helpers.push(h); return h }, platform: 'win32' })
    try {
      assert.deepEqual((await api<KeepAwakeState>(c, 'GET', '/api/keep-awake')).body, { mode: 'off', active: false, reason: 'Off' })
      assert.equal((await api(c, 'PUT', '/api/keep-awake', { mode: 'sometimes' })).status, 400)
      assert.equal((await api(c, 'PUT', '/api/keep-awake', { mode: 'always', extra: 1 })).status, 400)
      const r = await api<KeepAwakeState>(c, 'PUT', '/api/keep-awake', { mode: 'always' })
      assert.equal(r.status, 200)
      assert.equal(r.body.active, true)
      assert.equal(helpers.length, 1)
      const snap = (await api(c, 'GET', '/api/snapshot')).body
      assert.deepEqual(snap.resources.keepAwake, { mode: 'always', active: true, reason: 'Always while Colony runs' })
      await api(c, 'PUT', '/api/keep-awake', { mode: 'off' })
      assert.equal(helpers[0].killed, true)
    } finally { await teardown(c) }
  })
})
