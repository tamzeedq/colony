// Iteration 1 #6: agents started on an older image or older role instructions are flagged, and
// "restart to update" brings them current (keeping a commander-customised prompt).

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, Project } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT } from './config'
import { createFakeDriver, type FakeDriver } from './infra/fake'

const ADMIN = 'admin-secret-for-tests'
interface Ctx { app: ColonyApp; infra: FakeDriver; base: string; dir: string; roles: string }

async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'colony-out-'))
  const roles = join(dir, 'roles')
  cpSync(join(REPO_ROOT, 'roles'), roles, { recursive: true })
  const infra = createFakeDriver()
  const config = loadConfig({}, { dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: roles, oauthToken: 'sk-ant-oat-test-token-not-real', adminToken: ADMIN, port: 0, bind: '127.0.0.1' })
  const app = await createApp({ config, infra, poll: false, quiet: true })
  const port = await app.start(0, '127.0.0.1')
  return { app, infra, dir, roles, base: `http://127.0.0.1:${port}` }
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
const outdated = (c: Ctx, id: string) => c.app.store.agents.get(id)!.agent.outdated ?? []

describe('outdated agents', () => {
  test('a rebuilt image and changed role files flag agents; restart-outdated brings them current', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const a = (await api<Agent>(c, 'POST', `/api/projects/${p.id}/agents`, { role: 'backend' })).body
      const custom = (await api<Agent>(c, 'POST', `/api/projects/${p.id}/agents`, { role: 'frontend', rolePrompt: 'You are my hand-written frontend agent.' })).body
      await c.app.agents.refreshOutdated(true)
      assert.deepEqual(outdated(c, a.id), [])

      // Rebuild the image and edit the role files.
      c.infra.imageIds.set('colony-agent:dev', 'sha256:fake-image-2')
      appendFileSync(join(c.dir, 'roles', 'backend.md'), '\n\nNew rule: write tests first.\n')
      appendFileSync(join(c.dir, 'roles', 'frontend.md'), '\n\nNew rule: check accessibility.\n')
      await c.app.agents.refreshOutdated(true)
      assert.deepEqual(outdated(c, a.id), ['image', 'instructions'])
      assert.deepEqual(outdated(c, custom.id), ['image'], 'a customised prompt is never flagged or replaced')

      const r = await api(c, 'POST', '/api/agents/restart-outdated', {})
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(new Set(r.body.restarted), new Set([a.id, custom.id]))
      await c.app.agents.refreshOutdated(true)
      assert.deepEqual(outdated(c, a.id), [])
      assert.deepEqual(outdated(c, custom.id), [])
      assert.match(c.app.store.agents.get(a.id)!.agent.rolePrompt, /write tests first/)
      const kept = c.app.store.agents.get(custom.id)!.agent.rolePrompt
      assert.match(kept, /my hand-written frontend agent/)
      assert.doesNotMatch(kept, /check accessibility/)
    } finally { await teardown(c) }
  })

  test('editing an agent\'s prompt in Config marks it custom; single update endpoint works', async () => {
    const c = await setup()
    try {
      const p = (await api<Project>(c, 'POST', '/api/projects', { name: 'Readable' })).body
      const a = (await api<Agent>(c, 'POST', `/api/projects/${p.id}/agents`, { role: 'qa' })).body
      await api(c, 'PATCH', `/api/agents/${a.id}`, { rolePrompt: 'Custom QA prompt.' })
      appendFileSync(join(c.dir, 'roles', 'qa.md'), '\n\nChanged.\n')
      await c.app.agents.refreshOutdated(true)
      assert.deepEqual(outdated(c, a.id), [], 'custom prompts are left alone')
      c.infra.imageIds.set('colony-agent:dev', 'sha256:fake-image-3')
      await c.app.agents.refreshOutdated(true)
      assert.deepEqual(outdated(c, a.id), ['image'])
      assert.equal((await api(c, 'POST', `/api/agents/${a.id}/update`)).status, 200)
      await c.app.agents.refreshOutdated(true)
      assert.deepEqual(outdated(c, a.id), [])
    } finally { await teardown(c) }
  })
})
