// Inbox (feedback item 17): dismiss vs act, reopen, default Dismiss action, 30-day retention.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Alert, MergeRequest } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT } from './config'
import { createFakeDriver } from './infra/fake'

const ADMIN = 'admin-secret-for-tests'

interface Ctx { app: ColonyApp; base: string; dir: string }

async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'colony-inbox-'))
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

describe('inbox alerts', () => {
  test('resolve records how: dismissed, acted (default), and reopen clears it', async () => {
    const c = await setup()
    try {
      const a = c.app.store.raiseAlert({ kind: 'budget', severity: 'heads_up', title: 'Near cap', actions: [{ id: 'raise-cap', label: 'Raise cap' }] })
      const b = c.app.store.raiseAlert({ kind: 'budget', severity: 'heads_up', title: 'Another', actions: [{ id: 'raise-cap', label: 'Raise cap' }] })
      const d = await api<Alert>(c, 'POST', `/api/alerts/${a.id}/resolve`, { resolution: 'dismissed' })
      assert.equal(d.status, 200)
      assert.equal(d.body.resolution, 'dismissed')
      assert.ok(d.body.resolvedAt)
      const x = await api<Alert>(c, 'POST', `/api/alerts/${b.id}/resolve`)
      assert.equal(x.body.resolution, 'acted')
      assert.equal((await api(c, 'POST', `/api/alerts/${b.id}/resolve`, { resolution: 'nope' })).status, 400)

      const r = await api<Alert>(c, 'POST', `/api/alerts/${a.id}/reopen`)
      assert.equal(r.status, 200)
      assert.equal(r.body.resolvedAt, undefined)
      assert.equal(r.body.resolution, undefined)
      assert.equal(c.app.store.alerts.get(a.id)?.resolvedAt, undefined)
      assert.equal((await api(c, 'POST', '/api/alerts/al-missing/reopen')).status, 404)
    } finally { await teardown(c) }
  })

  test('informational alerts get a default Dismiss action', async () => {
    const c = await setup()
    try {
      const a = c.app.store.raiseAlert({ kind: 'crash', severity: 'heads_up', title: 'Mira resumed after restart' })
      assert.deepEqual(a.actions, [{ id: 'dismiss', label: 'Dismiss' }])
      const e = c.app.store.raiseAlert({ kind: 'crash', severity: 'heads_up', title: 'x', actions: [] })
      assert.equal(e.actions[0]?.id, 'dismiss')
      const own = c.app.store.raiseAlert({ kind: 'question', severity: 'needs_you', title: 'q', actions: [{ id: 'reply:a', label: 'A' }] })
      assert.deepEqual(own.actions.map((x) => x.id), ['reply:a'])
    } finally { await teardown(c) }
  })

  test('resolved alerts older than 30 days are pruned; recent ones are kept', async () => {
    const c = await setup()
    try {
      const s = c.app.store
      const old = s.raiseAlert({ kind: 'budget', severity: 'heads_up', title: 'old' })
      const recent = s.raiseAlert({ kind: 'budget', severity: 'heads_up', title: 'recent' })
      const open = s.raiseAlert({ kind: 'budget', severity: 'heads_up', title: 'open' })
      s.resolveAlert(recent.id, 'dismissed')
      s.upsertAlert({ ...old, resolvedAt: new Date(Date.now() - 31 * 86_400_000).toISOString(), resolution: 'dismissed' })
      assert.equal(s.pruneResolvedAlerts(), 1)
      assert.equal(s.alerts.has(old.id), false)
      assert.ok(s.alerts.has(recent.id) && s.alerts.has(open.id))
      assert.equal(s.db.get('SELECT id FROM alerts WHERE id = ?', old.id), undefined)
      assert.ok(s.db.get('SELECT id FROM alerts WHERE id = ?', recent.id))
    } finally { await teardown(c) }
  })

  test('dismissing an approval alert leaves the merge request pending', async () => {
    const c = await setup()
    try {
      const s = c.app.store
      const mr = { id: 'mr-test-1', projectId: 'p-x', branch: 'agent/x', status: 'open', requestedBy: 'you' } as unknown as MergeRequest
      s.saveMergeRequest(mr)
      s.raiseAlert({ id: 'al-mr-test-1', kind: 'approval', severity: 'needs_you', title: 'Merge?', actions: [{ id: 'approve', label: 'Approve' }] })
      const before = JSON.stringify(s.mergeRequests.get(mr.id))
      const r = await api<Alert>(c, 'POST', '/api/alerts/al-mr-test-1/resolve', { resolution: 'dismissed' })
      assert.equal(r.body.resolution, 'dismissed')
      assert.equal(JSON.stringify(s.mergeRequests.get(mr.id)), before)
      assert.equal(s.mergeRequests.get(mr.id)?.status, 'open')
    } finally { await teardown(c) }
  })
})
