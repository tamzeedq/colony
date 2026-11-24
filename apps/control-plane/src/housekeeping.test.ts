// Housekeeping (iteration 2 #18–20): finished quests archive, resolved alerts and old events are removed.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Quest } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT } from './config'
import { createFakeDriver } from './infra/fake'

const ADMIN = 'admin-secret-for-tests'
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString()

interface Ctx { app: ColonyApp; base: string; dir: string }
async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'colony-hk-'))
  const config = loadConfig({}, {
    dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
    oauthToken: 'sk-ant-oat-test-token-not-real', adminToken: ADMIN, port: 0, bind: '127.0.0.1',
  })
  const app = await createApp({ config, infra: createFakeDriver(), poll: false, quiet: true })
  const port = await app.start(0, '127.0.0.1')
  return { app, dir, base: `http://127.0.0.1:${port}` }
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
async function quest(c: Ctx, projectId: string, title: string, patch: Partial<Quest> = {}): Promise<Quest> {
  const r = await api<any>(c, 'POST', `/api/projects/${projectId}/quests`, { title })
  const q: Quest = r.body.quest ?? r.body
  c.app.store.saveQuest({ ...c.app.store.quests.get(q.id)!, ...patch })
  return c.app.store.quests.get(q.id)!
}

describe('housekeeping', () => {
  test('finishedAt is stamped when a quest finishes and cleared (with archivedAt) when reopened', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const q = await quest(c, p.id, 'A', { status: 'done' })
      assert.ok(q.finishedAt)
      c.app.store.saveQuest({ ...q, archivedAt: daysAgo(0) })
      c.app.store.saveQuest({ ...c.app.store.quests.get(q.id)!, status: 'in_progress' })
      const back = c.app.store.quests.get(q.id)!
      assert.equal(back.finishedAt, undefined)
      assert.equal(back.archivedAt, undefined)
    } finally { await teardown(c) }
  })

  test('run archives quests finished longer ago than the setting; preview matches', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const old = await quest(c, p.id, 'old', { status: 'done', finishedAt: daysAgo(10) })
      const oldFail = await quest(c, p.id, 'old fail', { status: 'failed', finishedAt: daysAgo(9) })
      const recent = await quest(c, p.id, 'recent', { status: 'done', finishedAt: daysAgo(1) })
      const open = await quest(c, p.id, 'open', { status: 'backlog' })

      const g = await api(c, 'GET', '/api/housekeeping')
      assert.equal(g.status, 200)
      assert.deepEqual(g.body.settings, { archiveQuestsAfterDays: 7, keepResolvedAlertsDays: 30, keepEventsDays: 60 })
      assert.equal(g.body.preview.questsToArchive, 2)

      const r = await api(c, 'POST', '/api/housekeeping/run')
      assert.equal(r.body.questsToArchive, 2)
      const s = c.app.store.quests
      assert.ok(s.get(old.id)!.archivedAt)
      assert.ok(s.get(oldFail.id)!.archivedAt)
      assert.equal(s.get(recent.id)!.archivedAt, undefined)
      assert.equal(s.get(open.id)!.archivedAt, undefined)
      assert.equal((await api(c, 'GET', '/api/housekeeping')).body.preview.questsToArchive, 0)

      // 0 = never
      await api(c, 'PUT', '/api/housekeeping', { archiveQuestsAfterDays: 0 })
      await quest(c, p.id, 'ancient', { status: 'done', finishedAt: daysAgo(400) })
      assert.equal((await api(c, 'POST', '/api/housekeeping/run')).body.questsToArchive, 0)
    } finally { await teardown(c) }
  })

  test('settings validate and persist', async () => {
    const c = await setup()
    try {
      assert.equal((await api(c, 'PUT', '/api/housekeeping', { keepEventsDays: -1 })).status, 400)
      assert.equal((await api(c, 'PUT', '/api/housekeeping', { keepEventsDays: 1.5 })).status, 400)
      assert.equal((await api(c, 'PUT', '/api/housekeeping', { bogus: 3 })).status, 400)
      const r = await api(c, 'PUT', '/api/housekeeping', { keepResolvedAlertsDays: 3 })
      assert.equal(r.status, 200)
      assert.equal(r.body.settings.keepResolvedAlertsDays, 3)
      assert.equal(r.body.settings.archiveQuestsAfterDays, 7)
      assert.equal(c.app.store.alertRetentionDays(), 3)
    } finally { await teardown(c) }
  })

  test('archive finished per base, archive/restore one quest, only finished quests', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const d1 = await quest(c, p.id, 'd1', { status: 'done' })
      const d2 = await quest(c, p.id, 'd2', { status: 'failed' })
      const wip = await quest(c, p.id, 'wip', { status: 'in_progress' })
      const r = await api(c, 'POST', `/api/projects/${p.id}/quests/archive-finished`)
      assert.deepEqual(r.body, { archived: 2 })
      assert.ok(c.app.store.quests.get(d1.id)!.archivedAt)
      assert.equal(c.app.store.quests.get(wip.id)!.archivedAt, undefined)
      assert.equal((await api(c, 'POST', '/api/projects/nope/quests/archive-finished')).status, 404)

      const restored = await api<Quest>(c, 'POST', `/api/quests/${d2.id}/archive`, { archived: false })
      assert.equal(restored.status, 200)
      assert.equal(restored.body.archivedAt, undefined)
      assert.equal(restored.body.status, 'failed')
      assert.equal((await api(c, 'POST', `/api/quests/${wip.id}/archive`, { archived: true })).status, 400)
      assert.equal((await api(c, 'POST', `/api/quests/${d2.id}/archive`, {})).status, 400)
      assert.ok((await api<Quest>(c, 'POST', `/api/quests/${d2.id}/archive`, { archived: true })).body.archivedAt)
    } finally { await teardown(c) }
  })

  test('clear resolved alerts (all or one base) never touches open ones', async () => {
    const c = await setup()
    try {
      const s = c.app.store
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const a = s.raiseAlert({ kind: 'budget', severity: 'heads_up', title: 'a', projectId: p.id })
      const b = s.raiseAlert({ kind: 'budget', severity: 'heads_up', title: 'b' })
      const open = s.raiseAlert({ kind: 'budget', severity: 'heads_up', title: 'open', projectId: p.id })
      s.resolveAlert(a.id, 'dismissed'); s.resolveAlert(b.id, 'acted')
      assert.deepEqual((await api(c, 'DELETE', `/api/alerts/resolved?projectId=${p.id}`)).body, { removed: 1 })
      assert.equal(s.alerts.has(a.id), false)
      assert.equal(s.alerts.has(b.id), true)
      assert.deepEqual((await api(c, 'DELETE', '/api/alerts/resolved')).body, { removed: 1 })
      assert.equal(s.alerts.has(open.id), true)
      assert.equal(s.alerts.size, 1)
    } finally { await teardown(c) }
  })

  test('old activity events are removed by run; recent ones stay', async () => {
    const c = await setup()
    try {
      const s = c.app.store
      s.addEvent({ id: 'e-old', agentId: 'ag-x', projectId: 'p-x', at: daysAgo(90), kind: 'note', text: 'old' } as any)
      s.addEvent({ id: 'e-new', agentId: 'ag-x', projectId: 'p-x', at: daysAgo(1), kind: 'note', text: 'new' } as any)
      assert.equal((await api(c, 'GET', '/api/housekeeping')).body.preview.eventsToRemove, 1)
      assert.equal((await api(c, 'POST', '/api/housekeeping/run')).body.eventsToRemove, 1)
      assert.deepEqual(s.recentEvents(50).map((e) => e.id).filter((id) => id.startsWith('e-')), ['e-new'])
    } finally { await teardown(c) }
  })
})
