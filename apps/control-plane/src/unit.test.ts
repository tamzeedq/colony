import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { parseDotEnv, REPO_ROOT, loadConfig } from './config'
import { fillPlaceholders, RoleLibrary } from './roles'
import { levelFor, projectHealth, slugify } from './store'

test('fillPlaceholders fills known vars and leaves unknown ones', () => {
  const warnings: string[] = []
  const out = fillPlaceholders('{project} / {stack} / {goal} / {orchestrator} / {nope} / {"json": 1}', { project: 'P', stack: ['a', 'b'], goal: 'G' }, (m) => warnings.push(m))
  assert.equal(out, 'P / a, b / G / the Orchestrator / {nope} / {"json": 1}')
  assert.equal(warnings.length, 1)
})

test('role composition layers', () => {
  const lib = new RoleLibrary(join(REPO_ROOT, 'roles'), () => {})
  const vars = { project: 'Readable', stack: ['Next.js'], goal: 'Ship it', orchestrator: 'Atlas-01' }
  const orch = lib.compose('orchestrator', vars)
  const worker = lib.compose('backend', vars)
  const custom = lib.compose('custom', vars, '# Role: Mobile\n\nAsk {orchestrator}.')
  assert.match(orch, /Readable/)
  assert.ok(!/\{project\}|\{goal\}/.test(orch + worker))
  assert.match(worker, /Atlas-01/)
  assert.ok(worker.length > orch.length / 4)
  assert.match(custom, /# Role: Mobile\n\nAsk Atlas-01\./)
})

test('config defaults and .env parsing', () => {
  const c = loadConfig({}, { repoRoot: REPO_ROOT, oauthToken: 'secret' })
  assert.equal(c.port, 7700)
  assert.equal(c.bind, '0.0.0.0')
  assert.equal(c.publicRunnerUrl, 'ws://host.docker.internal:7700/api/runner')
  assert.equal(c.agentImage, 'colony-agent:dev')
  assert.ok(!JSON.stringify(c).includes('secret'), 'token is not serialisable')
  assert.equal(loadConfig({ COLONY_PORT: '8800' }, { repoRoot: REPO_ROOT }).publicRunnerUrl, 'ws://host.docker.internal:8800/api/runner')
  assert.deepEqual(parseDotEnv('# c\nA=1\nB="two words"\nexport C=3 # note\n'), { A: '1', B: 'two words', C: '3' })
})

test('derived helpers', () => {
  assert.equal(slugify('Readable App!'), 'readable-app')
  assert.equal(slugify('***'), 'project')
  assert.deepEqual(levelFor(0), { level: 1, xp: 0 })
  assert.deepEqual(levelFor(12), { level: 3, xp: 40 })
  assert.equal(projectHealth([]).label, 'dormant')
})
