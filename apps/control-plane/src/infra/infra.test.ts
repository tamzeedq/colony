import { test } from 'node:test'
import assert from 'node:assert/strict'
import type Dockerode from 'dockerode'
import { createFakeDriver } from './fake'
import { computeStats, parseBranchList } from './docker'
import {
  InfraValidationError, assertAgentId, assertEnv, assertRepoUrl, assertSlug, isValidBranchName,
} from './validate'

const spec = (agentId = 'vex-07', projectSlug = 'demo') => ({
  agentId, projectSlug, image: 'colony-agent:dev', env: { COLONY_AGENT_ID: agentId }, memoryMb: 2048, cpus: 2,
})

test('branch name validation mirrors git check-ref-format', () => {
  for (const ok of ['agent/vex-07', 'main', 'feature/a.b', 'x_y-z', 'a/b/c']) assert.ok(isValidBranchName(ok), ok)
  for (const bad of [
    '', '-rf', '--upload-pack=x', 'a b', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', '/a', 'a/',
    'a.', 'a//b', '.hidden', 'a/.b', 'x.lock', 'a/b.lock/c', '@', 'a@{1}', 'a;rm -rf /', '$(id)', 'a\nb', 'é',
  ]) assert.equal(isValidBranchName(bad), false, JSON.stringify(bad))
})

test('slug, agent id, env and repo url validation', () => {
  assert.equal(assertSlug('my-proj-1'), 'my-proj-1')
  for (const bad of ['', 'My', '-x', 'a_b', 'a/b', 'a b', 'x'.repeat(49)]) {
    assert.throws(() => assertSlug(bad), InfraValidationError, bad)
  }
  assert.equal(assertAgentId('vex-07'), 'vex-07')
  for (const bad of ['', '-a', 'a/b', 'a b', '../x']) assert.throws(() => assertAgentId(bad), InfraValidationError)
  assert.deepEqual(assertEnv({ A: '1', B_2: 'x=y' }), ['A=1', 'B_2=x=y'])
  assert.throws(() => assertEnv({ 'A-B': '1' }), InfraValidationError)
  assert.throws(() => assertEnv({ '1A': '1' }), InfraValidationError)
  for (const ok of ['https://github.com/a/b.git', 'git://host/x', 'ssh://git@h/x', 'git@github.com:a/b.git']) {
    assert.equal(assertRepoUrl(ok), ok)
  }
  for (const bad of ['-u', '--upload-pack=touch /x', 'file:///etc', 'ext::sh -c id', '/srv/git', 'https://a b']) {
    assert.throws(() => assertRepoUrl(bad), InfraValidationError, bad)
  }
})

test('parseBranchList', () => {
  const out = 'main aaa 0 0\nagent/vex-07 bbb 2 3\n\ngarbage\n'
  assert.deepEqual(parseBranchList(out), [
    { name: 'main', sha: 'aaa', behindMain: 0, aheadOfMain: 0 },
    { name: 'agent/vex-07', sha: 'bbb', behindMain: 2, aheadOfMain: 3 },
  ])
})

test('computeStats uses cpu/system deltas and subtracts inactive file cache', () => {
  const s = {
    cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 20_000_000_000, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 10_000_000_000 },
    memory_stats: { usage: 300 * 1024 * 1024, limit: 2048 * 1024 * 1024, stats: { inactive_file: 100 * 1024 * 1024 } },
  } as unknown as Dockerode.ContainerStats
  assert.deepEqual(computeStats(s), { cpuPct: 40, memMb: 200, memLimitMb: 2048 })
  const empty = { cpu_stats: {}, precpu_stats: {}, memory_stats: {} } as unknown as Dockerode.ContainerStats
  assert.deepEqual(computeStats(empty), { cpuPct: 0, memMb: 0, memLimitMb: 0 })
})

test('fake: project lifecycle, agents, stats and call recording', async () => {
  const d = createFakeDriver()
  assert.equal(await d.ping(), true)
  await assert.rejects(d.startAgent(spec()), /ensureProject/)
  await d.ensureProject('demo', { projectName: 'Demo' })
  await d.ensureProject('demo')
  assert.equal(d.projects.size, 1)
  assert.deepEqual(await d.startAgent(spec()), { name: 'colony-agent-vex-07' })
  const list = await d.listContainers()
  assert.deepEqual(list.map((c) => [c.name, c.kind, c.running]), [
    ['colony-git-demo', 'git', true], ['colony-agent-vex-07', 'agent', true],
  ])
  const st = await d.agentStats('vex-07')
  assert.equal(st?.running, true)
  assert.equal(st?.memLimitMb, 2048)
  assert.equal(await d.agentStats('nobody'), null)
  await d.stopAgent('vex-07')
  assert.equal((await d.agentStats('vex-07'))?.running, false)
  await d.stopAgent('vex-07', { remove: true })
  assert.equal(d.agents.size, 0)
  assert.ok(d.volumes.has('colony-ws-vex-07'), 'volume kept after container removal')
  await d.removeAgentVolume('vex-07')
  assert.equal(d.volumes.size, 0)
  assert.equal(d.callsTo('ensureProject').length, 2)
  assert.deepEqual(d.callsTo('stopAgent').map((c) => c.args), [['vex-07', {}], ['vex-07', { remove: true }]])
})

test('fake: branches, diff and merges', async () => {
  const d = createFakeDriver()
  await d.ensureProject('demo')
  d.setBranch('demo', 'agent/a', { diff: 'DIFF-A' })
  d.setBranch('demo', 'agent/b', { conflict: true })
  const before = (await d.listBranches('demo')).find((b) => b.name === 'main')!.sha
  assert.equal((await d.listBranches('demo')).find((b) => b.name === 'agent/a')?.aheadOfMain, 1)
  assert.equal(await d.diff('demo', 'agent/a'), 'DIFF-A')
  await assert.rejects(d.diff('demo', 'nope'), /no such branch/)
  await assert.rejects(d.diff('demo', '-x'), InfraValidationError)

  const m = await d.mergeToMain('demo', 'agent/a', 'Merge agent/a')
  assert.equal(m.ok, true)
  assert.ok(m.ok && m.sha !== before)
  assert.equal((await d.listBranches('demo')).find((b) => b.name === 'agent/a')?.aheadOfMain, 0)
  const again = await d.mergeToMain('demo', 'agent/a', 'again')
  assert.equal(again.ok, true)

  assert.deepEqual(await d.mergeToMain('demo', 'agent/b', 'Merge b'), {
    ok: false, conflict: true, message: 'merge conflict merging agent/b into main',
  })
  assert.deepEqual(await d.mergeToMain('demo', 'ghost', 'x'), { ok: false, conflict: false, message: 'no such branch: ghost' })
  await assert.rejects(d.mergeToMain('demo', 'a..b', 'x'), InfraValidationError)

  d.nextMergeResult({ ok: false, conflict: false, message: 'boom' })
  assert.equal((await d.mergeToMain('demo', 'agent/a', 'x')).message, 'boom')
})

test('fake: failNext, setPing, remove without/with purge', async () => {
  const d = createFakeDriver()
  d.failNext('ensureProject', new Error('docker down'))
  await assert.rejects(d.ensureProject('demo'), /docker down/)
  await d.ensureProject('demo')
  d.setPing(false)
  assert.equal(await d.ping(), false)

  d.setBranch('demo', 'agent/a')
  await d.startAgent(spec())
  await d.removeProject('demo')
  assert.equal((await d.listContainers()).length, 0)
  assert.ok(d.volumes.has('colony-ws-vex-07'))
  await d.ensureProject('demo')
  assert.ok((await d.listBranches('demo')).some((b) => b.name === 'agent/a'), 'repo survives non-purge removal')

  await d.startAgent(spec())
  await d.removeProject('demo', { purge: true })
  assert.equal(d.volumes.size, 0)
  await d.ensureProject('demo')
  assert.equal((await d.listBranches('demo')).length, 1, 'purge drops the repo')
})
