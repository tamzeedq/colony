// Phase 6 §4 (docs/phase6.md): cost analytics — migration, usage writes, aggregation,
// recommendation rules and query validation. Fake InfraDriver, temp DB.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, Analytics, Project, UsageTotals } from '@colony/shared'
import { AnalyticsService, MIN_COST_USD, parseDays, recommend } from './analytics'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT } from './config'
import { Db, MIGRATIONS } from './db'
import { createFakeDriver } from './infra/fake'
import { localDay, type Store } from './store'

const require = createRequire(import.meta.url)
const OAUTH = 'sk-ant-oat-test-token-not-real'
const ADMIN = 'admin-secret-for-tests'

interface Ctx { app: ColonyApp; base: string; dir: string }

async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'colony-p6a-'))
  const config = loadConfig({}, {
    dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
    oauthToken: OAUTH, adminToken: ADMIN, port: 0, bind: '127.0.0.1',
  })
  const app = await createApp({ config, infra: createFakeDriver(), poll: false, quiet: true })
  const port = await app.start(0, '127.0.0.1')
  return { app, dir, base: `http://127.0.0.1:${port}` }
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
async function project(c: Ctx, name: string) {
  const r = await api<Project>(c, 'POST', '/api/projects', { name, goal: 'Ship it' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}
async function spawn(c: Ctx, projectId: string, role: string, model?: string) {
  const r = await api<Agent>(c, 'POST', `/api/projects/${projectId}/agents`, { role, ...(model ? { model } : {}) })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}

const NOW = new Date(2026, 10, 10, 12, 0, 0)
const dayAgo = (n: number, now = NOW) => localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n))

function insertUsage(db: Db, r: { day: string; agent: string; project: string; role?: string | null; model?: string | null; cost: number; tokens: number; done?: number; failed?: number }) {
  db.run(
    `INSERT INTO usage_daily(day, agent_id, project_id, role, model, cost_usd, tokens, quests_done, quests_failed) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.day, r.agent, r.project, r.role ?? null, r.model ?? null, r.cost, r.tokens, r.done ?? 0, r.failed ?? 0,
  )
}

// ── migration ────────────────────────────────────────────────────────────────

describe('usage_daily migration', () => {
  test('a v1 database gains role/model/quest columns and old rows read as unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'colony-p6m-'))
    const path = join(dir, 'old.db')
    try {
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
      const old = new DatabaseSync(path)
      old.exec(MIGRATIONS[0])
      old.exec('PRAGMA user_version = 1')
      old.prepare('INSERT INTO usage_daily(day, agent_id, project_id, cost_usd, tokens) VALUES(?, ?, ?, ?, ?)').run(dayAgo(1), 'ag-old', 'pr-old', 2.5, 1000)
      old.close()

      const db = new Db(path)
      try {
        assert.equal(Number(db.get('PRAGMA user_version')!.user_version), MIGRATIONS.length)
        const cols = db.all('PRAGMA table_info(usage_daily)').map((r) => String(r.name))
        for (const c of ['role', 'model', 'quests_done', 'quests_failed']) assert.ok(cols.includes(c), `missing column ${c}`)
        const row = db.get('SELECT * FROM usage_daily WHERE agent_id = ?', 'ag-old')!
        assert.equal(row.role, null)
        assert.equal(row.quests_done, 0)

        const fakeStore = { projects: new Map() } as unknown as Store
        const a = new AnalyticsService(db, fakeStore).compute(7, NOW)
        assert.equal(a.totals.costUsd, 2.5)
        assert.deepEqual(a.byRole.map((r) => r.role), ['unknown'])
        assert.deepEqual(a.byModel.map((m) => [m.model, m.name]), [['unknown', 'Unknown']])
        assert.equal(a.byProject[0].name, 'Removed base')
      } finally { db.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── writes from the live paths ───────────────────────────────────────────────

describe('usage writes', () => {
  let c: Ctx
  before(async () => { c = await setup() })
  after(async () => { await teardown(c) })

  test('addUsage records the agent role and model; quest outcomes count per assignee', async () => {
    const p = await project(c, 'Writes')
    const qa = await spawn(c, p.id, 'qa', 'sonnet-5.5')
    c.app.store.addUsage(qa.id, 0.4, 1200)
    c.app.store.addUsage(qa.id, 0.1, 300)
    let row = c.app.db.get('SELECT * FROM usage_daily WHERE agent_id = ?', qa.id)!
    assert.equal(row.role, 'qa')
    assert.equal(row.model, 'sonnet-5.5')
    assert.equal(Number(row.cost_usd), 0.5)
    assert.equal(Number(row.tokens), 1500)

    // Model switch: later writes that day take the new model.
    c.app.store.patchAgent(qa.id, { model: 'haiku-5.5' })
    c.app.store.addUsage(qa.id, 0.01, 100)
    assert.equal(c.app.db.get('SELECT model FROM usage_daily WHERE agent_id = ?', qa.id)!.model, 'haiku-5.5')

    const q1 = c.app.quests.create(p.id, { title: 'Test streaks' }, 'you')
    c.app.quests.assign(q1.id, qa.id, p.id)
    c.app.quests.patch(q1.id, { status: 'done' }, 'you')
    const q2 = c.app.quests.create(p.id, { title: 'Test badges' }, 'you')
    c.app.quests.assign(q2.id, qa.id, p.id)
    c.app.quests.patch(q2.id, { status: 'failed' }, 'you')
    row = c.app.db.get('SELECT * FROM usage_daily WHERE agent_id = ?', qa.id)!
    assert.equal(Number(row.quests_done), 1)
    assert.equal(Number(row.quests_failed), 1)

    const a = c.app.analytics.compute(7)
    assert.equal(a.totals.questsDone, 1)
    assert.equal(a.totals.questsFailed, 1)
    assert.equal(a.totals.costPerQuestUsd, 0.51)
  })
})

// ── aggregation + HTTP ───────────────────────────────────────────────────────

describe('GET /api/analytics', () => {
  let c: Ctx
  let pa: Project, pb: Project
  before(async () => {
    c = await setup()
    pa = await project(c, 'Alpha')
    pb = await project(c, 'Beta')
    const db = c.app.db
    const today = localDay()
    const ago = (n: number) => dayAgo(n, new Date())
    insertUsage(db, { day: today, agent: 'a1', project: pa.id, role: 'orchestrator', model: 'opus-5.5', cost: 3, tokens: 50_000 })
    insertUsage(db, { day: ago(1), agent: 'a1', project: pa.id, role: 'orchestrator', model: 'opus-5.5', cost: 2, tokens: 40_000 })
    insertUsage(db, { day: today, agent: 'a2', project: pa.id, role: 'qa', model: 'sonnet-5.5', cost: 1, tokens: 20_000, done: 3 })
    insertUsage(db, { day: ago(3), agent: 'a3', project: pb.id, role: 'backend', model: 'sonnet-5.5', cost: 4, tokens: 80_000, done: 1, failed: 1 })
    insertUsage(db, { day: ago(6), agent: 'old', project: pb.id, cost: 0.5, tokens: 5000 }) // pre-migration row
    insertUsage(db, { day: ago(10), agent: 'a3', project: pb.id, role: 'backend', model: 'sonnet-5.5', cost: 20, tokens: 400_000, done: 2 }) // outside 7, inside 30
    insertUsage(db, { day: ago(40), agent: 'a3', project: pb.id, role: 'backend', model: 'sonnet-5.5', cost: 99, tokens: 1 }) // outside both
  })
  after(async () => { await teardown(c) })

  test('aggregates the last 7 days across days, projects, roles and models', async () => {
    const r = await api<Analytics>(c, 'GET', '/api/analytics')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const a = r.body
    assert.equal(a.days, 7)
    assert.equal(a.daily.length, 7)
    assert.equal(a.to, localDay())
    assert.equal(a.daily[6].day, localDay())
    assert.deepEqual(
      { cost: a.totals.costUsd, tokens: a.totals.tokens, done: a.totals.questsDone, failed: a.totals.questsFailed },
      { cost: 10.5, tokens: 195_000, done: 4, failed: 1 },
    )
    assert.equal(a.totals.costPerQuestUsd, 2.63)
    assert.equal(a.daily[6].costUsd, 4)
    assert.equal(a.daily[5].costUsd, 2)
    assert.equal(a.daily[4].costUsd, 0)
    assert.equal(a.daily[0].costUsd, 0.5)

    const proj = Object.fromEntries(a.byProject.map((p) => [p.name, [p.costUsd, p.questsDone]]))
    assert.deepEqual(proj, { Alpha: [6, 3], Beta: [4.5, 1] })
    assert.equal(a.byProject[0].projectId, pa.id) // sorted by cost
    const roles = Object.fromEntries(a.byRole.map((x) => [x.role, x.costUsd]))
    assert.deepEqual(roles, { orchestrator: 5, qa: 1, backend: 4, unknown: 0.5 })
    const models = Object.fromEntries(a.byModel.map((x) => [x.model, [x.name, x.costUsd]]))
    assert.deepEqual(models, { 'opus-5.5': ['Opus 5.5', 5], 'sonnet-5.5': ['Sonnet 5.5', 5], unknown: ['Unknown', 0.5] })
    assert.equal(a.byRole.find((x) => x.role === 'qa')!.costPerQuestUsd, 0.33)
    assert.equal(a.byRole.find((x) => x.role === 'orchestrator')!.costPerQuestUsd, null)

    // QA on Sonnet: 3 quests, no failures, $0.33/quest → Haiku. Backend had a failure → nothing.
    const ids = a.recommendations.map((x) => x.id)
    assert.ok(ids.includes('downshift-qa-sonnet-5.5'), JSON.stringify(a.recommendations))
    assert.ok(!ids.some((id) => id.startsWith('downshift-backend')))
    assert.ok(ids.includes('orchestrator-opus-5.5'))
    assert.equal(pb.id, a.byProject[1].projectId)
  })

  test('days=30 widens the window', async () => {
    const r = await api<Analytics>(c, 'GET', '/api/analytics?days=30')
    assert.equal(r.status, 200)
    assert.equal(r.body.days, 30)
    assert.equal(r.body.daily.length, 30)
    assert.equal(r.body.totals.costUsd, 30.5)
    assert.equal(r.body.totals.questsDone, 6)
  })

  test('validates days and requires the admin token', async () => {
    for (const bad of ['14', 'abc', '7.0', '-7', '0']) {
      const r = await api(c, 'GET', `/api/analytics?days=${bad}`)
      assert.equal(r.status, 400, `days=${bad}`)
      assert.equal(r.body.error.code, 'bad_request')
    }
    assert.equal((await api(c, 'GET', '/api/analytics', undefined, '')).status, 401)
    assert.equal(parseDays(undefined), 7)
    assert.equal(parseDays('30'), 30)
  })
})

// ── recommendation rules ─────────────────────────────────────────────────────

type Row = Parameters<typeof recommend>[0][number]
const row = (o: Partial<Row>): Row => ({
  day: '2026-11-10', agentId: 'a', projectId: 'p', role: 'qa', model: 'sonnet-5.5', costUsd: 0, tokens: 0, questsDone: 0, questsFailed: 0, ...o,
})
function totalsOf(rows: Row[]): UsageTotals {
  const t = { costUsd: 0, tokens: 0, questsDone: 0, questsFailed: 0, costPerQuestUsd: null }
  for (const r of rows) { t.costUsd += r.costUsd; t.tokens += r.tokens; t.questsDone += r.questsDone; t.questsFailed += r.questsFailed }
  return t
}
const run = (rows: Row[], days = 7) => recommend(rows, days, totalsOf(rows))

describe('recommendation rules', () => {
  test('too little data: empty list with a note', () => {
    const cheap = run([row({ costUsd: MIN_COST_USD - 0.01, questsDone: 10 })])
    assert.deepEqual(cheap.recommendations, [])
    assert.match(cheap.note!, /Not enough data/)
    assert.match(cheap.note!, /\$0\.99 spent and 10 quests/)
    const few = run([row({ costUsd: 50, questsDone: 2 })])
    assert.deepEqual(few.recommendations, [])
    assert.match(few.note!, /2 quests done/)
  })

  test('worker downshift fires with numbers and savings from relative prices', () => {
    const r = run([row({ costUsd: 2, questsDone: 4 }), row({ day: '2026-11-09', costUsd: 2, questsDone: 4 })])
    assert.equal(r.recommendations.length, 1)
    const rec = r.recommendations[0]
    assert.equal(rec.id, 'downshift-qa-sonnet-5.5')
    // $4/week on Sonnet (weight 20) → Haiku (weight 1): saves 4 × 19/20.
    assert.equal(rec.savingsUsdPerWeek, 3.8)
    assert.equal(rec.confidence, 'medium') // 8 quests
    assert.match(rec.title, /QA agents on Haiku 5\.5 would save about \$3\.80\/week/)
    assert.match(rec.detail, /8 quests with no failures for \$4\.00 \(\$0\.50 per quest\)/)
    assert.equal(r.note, undefined)
  })

  test('30-day windows scale savings to a week', () => {
    const r = run([row({ costUsd: 30, questsDone: 30 })], 30)
    assert.equal(r.recommendations[0].savingsUsdPerWeek, 6.65) // 30 × 7/30 × 0.95
    assert.equal(r.recommendations[0].confidence, 'high')
  })

  test('worker downshift does not fire on failures, pricey quests, Haiku or unknown rows', () => {
    assert.deepEqual(run([row({ costUsd: 2, questsDone: 4, questsFailed: 1 })]).recommendations, [])
    assert.deepEqual(run([row({ costUsd: 20, questsDone: 4 })]).recommendations, []) // $5/quest
    assert.deepEqual(run([row({ model: 'haiku-5.5', costUsd: 2, questsDone: 4 })]).recommendations, [])
    assert.deepEqual(run([row({ role: 'unknown', model: 'unknown', costUsd: 2, questsDone: 4 })]).recommendations, [])
    assert.deepEqual(run([row({ model: 'gpt-x', costUsd: 2, questsDone: 4 })]).recommendations, [])
    const none = run([row({ costUsd: 2, questsDone: 4, questsFailed: 1 })])
    assert.match(none.note!, /No savings found/)
  })

  test('code-writing roles are capped at medium confidence', () => {
    const r = run([row({ role: 'backend', costUsd: 10, questsDone: 20 })])
    assert.equal(r.recommendations[0].confidence, 'medium')
    assert.match(r.recommendations[0].detail, /try it on one agent first/)
  })

  test('orchestrator on Opus with light token volume → Sonnet; heavy volume → nothing', () => {
    const light = run([
      row({ role: 'orchestrator', model: 'opus-5.5', costUsd: 4, tokens: 100_000 }),
      row({ role: 'qa', model: 'haiku-5.5', costUsd: 0.5, questsDone: 3 }),
    ])
    assert.equal(light.recommendations.length, 1)
    const rec = light.recommendations[0]
    assert.equal(rec.id, 'orchestrator-opus-5.5')
    assert.equal(rec.savingsUsdPerWeek, 2) // 4 × (1 − 20/40)
    assert.equal(rec.confidence, 'low')
    assert.match(rec.detail, /averaged 100k tokens per active day over 1 agent-day/)

    const heavy = run([
      row({ role: 'orchestrator', model: 'opus-5.5', costUsd: 4, tokens: 900_000 }),
      row({ role: 'qa', model: 'haiku-5.5', costUsd: 0.5, questsDone: 3 }),
    ])
    assert.deepEqual(heavy.recommendations, [])
    const sonnet = run([
      row({ role: 'orchestrator', model: 'sonnet-5.5', costUsd: 4, tokens: 1000 }),
      row({ role: 'qa', model: 'haiku-5.5', costUsd: 0.5, questsDone: 3 }),
    ])
    assert.deepEqual(sonnet.recommendations, [])
  })

  test('recommendations are sorted by savings', () => {
    const r = run([
      row({ role: 'qa', costUsd: 1, questsDone: 3 }),
      row({ role: 'researcher', costUsd: 3, questsDone: 3 }),
    ])
    assert.deepEqual(r.recommendations.map((x) => x.id), ['downshift-researcher-sonnet-5.5', 'downshift-qa-sonnet-5.5'])
  })
})
