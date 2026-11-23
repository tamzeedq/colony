// Level / XP progression: quests done add xpReward, 300 XP per level, remainder carries.

import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, Project } from '@colony/shared'
import { createApp, type ColonyApp } from './app'
import { loadConfig, REPO_ROOT } from './config'
import { createFakeDriver } from './infra/fake'
import { applyXp } from './quests'

const ADMIN = 'admin-secret-for-tests'

describe('applyXp', () => {
  test('carries the remainder and can skip several levels', () => {
    assert.deepEqual(applyXp(1, 0, 100), { level: 1, xp: 100, leveledUp: false })
    assert.deepEqual(applyXp(1, 250, 100), { level: 2, xp: 50, leveledUp: true })
    assert.deepEqual(applyXp(2, 0, 650), { level: 4, xp: 50, leveledUp: true })
  })
})

describe('quest completion progression', () => {
  let app: ColonyApp
  let base = ''
  let dir = ''
  const api = async <T = any>(method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { authorization: `Bearer ${ADMIN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: (await res.json()) as T }
  }
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'colony-prog-'))
    const config = loadConfig({}, {
      dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
      oauthToken: 'sk-ant-oat-test-token-not-real', adminToken: ADMIN, port: 0, bind: '127.0.0.1',
    })
    app = await createApp({ config, infra: createFakeDriver(), poll: false, quiet: true })
    base = `http://127.0.0.1:${await app.start(0, '127.0.0.1')}`
  })
  after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }) })

  test('xp accumulates, levels up every 300, and the event says so', async () => {
    const p = (await api<Project>('POST', '/api/projects', { name: 'Readable', goal: 'Ship streaks' })).body
    const w = (await api<Agent>('POST', `/api/projects/${p.id}/agents`, { role: 'backend' })).body
    const done = (title: string, priority: 'low' | 'normal' | 'high') => {
      const q = app.quests.create(p.id, { title, priority }, 'you')
      app.quests.assign(q.id, w.id, p.id)
      app.quests.patch(q.id, { status: 'done' }, 'you')
    }
    const agent = () => app.store.agents.get(w.id)!.agent
    assert.equal(agent().level, 1)

    done('One', 'high')   // +150
    done('Two', 'normal') // +100 -> 250
    assert.deepEqual([agent().level, agent().xp, agent().questsDone], [1, 250, 2])
    assert.ok(!app.store.recentEvents(50).some((e) => /Level 2/.test(e.text)))

    done('Three', 'normal') // +100 -> 350 = Lv 2 + 50
    assert.deepEqual([agent().level, agent().xp, agent().questsDone], [2, 50, 3])
    const ev = app.store.recentEvents(50).find((e) => e.kind === 'quest_complete' && /"Three"/.test(e.text))!
    assert.match(ev.text, /\(\+100 XP\)/)
    assert.match(ev.text, /Level 2/)
  })
})
