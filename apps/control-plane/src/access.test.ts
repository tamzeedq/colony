// Feedback #19: local repo access and dev-server previews (fake driver), diff against any base.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, Project } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT } from './config'
import { createFakeDriver, type FakeDriver } from './infra/fake'
import { suggestPorts } from './access'

const ADMIN = 'admin-secret-for-tests'
interface Ctx { app: ColonyApp; infra: FakeDriver; base: string; dir: string }

async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'colony-acc-'))
  const infra = createFakeDriver()
  const config = loadConfig({}, { dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'), oauthToken: 'sk-ant-oat-test-token-not-real', adminToken: ADMIN, port: 0, bind: '127.0.0.1' })
  const app = await createApp({ config, infra, poll: false, quiet: true })
  const port = await app.start(0, '127.0.0.1')
  return { app, infra, dir, base: `http://127.0.0.1:${port}` }
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

describe('local access (feedback #19)', () => {
  test('suggestPorts reads recent commands, newest first, then common ports', () => {
    const p = suggestPorts(['npx vite --port 5175', 'CI=1 npx expo start --web --port 8099', 'curl localhost:8099'])
    assert.deepEqual(p.slice(0, 2), [8099, 5175])
    assert.ok(p.includes(5173) && p.length <= 6)
  })

  test('repo access opens once on 127.0.0.1 with fetch commands, and closes', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const slug = c.app.store.projects.get(p.id)!.slug
      assert.equal((await api(c, 'GET', `/api/projects/${p.id}/repo-access`)).body, null)
      const r = await api(c, 'POST', `/api/projects/${p.id}/repo-access`)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.match(r.body.url, /^git:\/\/127\.0\.0\.1:\d+\/repo\.git$/)
      assert.ok(r.body.commands.some((x: string) => x.startsWith(`git remote add colony-${slug} git://127.0.0.1:`)))
      assert.equal(c.infra.sidecars.get(`colony-repo-${slug}`)?.hostPort, r.body.port)
      const again = await api(c, 'POST', `/api/projects/${p.id}/repo-access`)
      assert.equal(again.body.port, r.body.port, 'idempotent')
      assert.equal(c.infra.callsTo('exposeRepo').length, 1)
      await api(c, 'DELETE', `/api/projects/${p.id}/repo-access`)
      assert.ok(!c.infra.sidecars.has(`colony-repo-${slug}`))
    } finally { await teardown(c) }
  })

  test('preview: suggested ports, start/restart/stop, removed with the agent; diff accepts a base', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const a = (await api<Agent>(c, 'POST', `/api/projects/${p.id}/agents`, { role: 'frontend' })).body
      c.app.store.addEvent({ id: 'ev-cmd', at: new Date().toISOString(), agentId: a.id, projectId: p.id, kind: 'command', text: 'npx vite --host 0.0.0.0 --port 5175', command: { cmd: 'npx vite --host 0.0.0.0 --port 5175' } })
      const info = await api(c, 'GET', `/api/agents/${a.id}/preview`)
      assert.equal(info.body.active, null)
      assert.equal(info.body.suggestedPorts[0], 5175)
      assert.equal((await api(c, 'POST', `/api/agents/${a.id}/preview`, {})).status, 400)
      assert.equal((await api(c, 'POST', `/api/agents/${a.id}/preview`, { port: 80 })).status, 400)
      const s = await api(c, 'POST', `/api/agents/${a.id}/preview`, { port: 5175 })
      assert.equal(s.status, 200, JSON.stringify(s.body))
      assert.match(s.body.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
      assert.equal(c.infra.sidecars.get(`colony-preview-${a.id}`)?.targetPort, 5175)
      const moved = await api(c, 'POST', `/api/agents/${a.id}/preview`, { port: 8099 })
      assert.equal(moved.body.port, s.body.port, 'same local port, new target')
      assert.equal(c.infra.sidecars.get(`colony-preview-${a.id}`)?.targetPort, 8099)
      // Removing the agent removes its preview.
      await api(c, 'DELETE', `/api/agents/${a.id}`)
      assert.ok(!c.infra.sidecars.has(`colony-preview-${a.id}`))

      const slug = c.app.store.projects.get(p.id)!.slug
      c.infra.setBranch(slug, 'agent/x', { diff: 'diff --git a/x b/x\n+x\n' })
      const d = await api(c, 'GET', `/api/projects/${p.id}/diff?branch=agent/x&base=agent/y`)
      assert.equal(d.status, 200)
      assert.deepEqual(c.infra.callsTo('diff').at(-1)!.args, [slug, 'agent/x', 'agent/y'])
      assert.equal((await api(c, 'GET', `/api/projects/${p.id}/diff?branch=agent/x&base=bad..name`)).status, 400)
    } finally { await teardown(c) }
  })
})
