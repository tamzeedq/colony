// End-to-end test of the Docker driver against the local Docker engine.
// Runs only with COLONY_DOCKER_TESTS=1 (needs the colony-agent:dev image).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createDockerDriver } from './docker'
import { PROTECTED_MESSAGE } from './git-scripts'

const enabled = process.env.COLONY_DOCKER_TESTS === '1'

test('docker driver end to end', { skip: !enabled && 'set COLONY_DOCKER_TESTS=1', timeout: 300_000 }, async (t) => {
  const id = randomBytes(3).toString('hex')
  const slug = `it-${id}`
  const agentId = `it-agent-${id}`
  const d = createDockerDriver({ agentCmd: ['sleep', 'infinity'] })
  const docker = d.docker
  const agentName = `colony-agent-${agentId}`
  t.after(async () => {
    await d.removeProject(slug, { purge: true }).catch(() => {})
  })

  assert.equal(await d.ping(), true)

  // ensureProject twice: second call is a no-op.
  await d.ensureProject(slug, { projectName: 'Integration Test' })
  const gitId1 = (await docker.getContainer(`colony-git-${slug}`).inspect()).Id
  await d.ensureProject(slug, { projectName: 'Integration Test' })
  assert.equal((await docker.getContainer(`colony-git-${slug}`).inspect()).Id, gitId1)

  const initial = await d.listBranches(slug)
  assert.equal(initial.length, 1)
  assert.equal(initial[0].name, 'main')
  const main0 = initial[0].sha

  // Agent container with a sleep command.
  const { name } = await d.startAgent({
    agentId, projectSlug: slug, image: 'colony-agent:dev',
    env: { COLONY_AGENT_ID: agentId, COLONY_GIT_URL: 'git://git/repo.git' }, memoryMb: 512, cpus: 1,
  })
  assert.equal(name, agentName)

  // Container hardening: no host mounts, no docker socket, caps dropped.
  const info = await docker.getContainer(agentName).inspect()
  assert.ok(info.Mounts.length === 1 && info.Mounts.every((m) => m.Type === 'volume'), JSON.stringify(info.Mounts))
  assert.equal(info.Mounts[0].Destination, '/workspace')
  assert.ok(!info.HostConfig.Binds || info.HostConfig.Binds.length === 0)
  assert.equal(info.HostConfig.Privileged, false)
  assert.deepEqual(info.HostConfig.CapDrop, ['ALL'])
  assert.ok(!info.HostConfig.CapAdd || info.HostConfig.CapAdd.length === 0)
  assert.deepEqual(info.HostConfig.SecurityOpt, ['no-new-privileges'])
  assert.equal(info.Config.User, 'node')
  assert.equal(info.HostConfig.Memory, 512 * 1024 * 1024)
  assert.equal(info.HostConfig.NanoCpus, 1e9)
  const sock = await d.exec(agentName, ['sh', '-c', 'ls -la /var/run/docker.sock /run/docker.sock 2>&1; mount | grep -c docker.sock || true'])
  assert.match(sock.stdout, /No such file/)
  assert.match(sock.stdout.trim().split('\n').pop()!, /^0$/)
  const caps = await d.exec(agentName, ['sh', '-c', 'grep -E "^Cap(Eff|Prm|Bnd)" /proc/self/status; grep NoNewPrivs /proc/self/status'])
  assert.match(caps.stdout, /CapEff:\s+0+\n/)
  assert.match(caps.stdout, /CapBnd:\s+0+\n/)
  assert.match(caps.stdout, /NoNewPrivs:\s+1/)
  const hostGw = await d.exec(agentName, ['getent', 'hosts', 'host.docker.internal'])
  assert.equal(hostGw.exitCode, 0, 'host.docker.internal resolves')

  const run = async (script: string) => {
    const r = await d.exec(agentName, ['sh', '-c', script])
    return r
  }
  const ok = async (script: string) => {
    const r = await run(script)
    assert.equal(r.exitCode, 0, `${script}\n${r.stdout}\n${r.stderr}`)
    return r
  }

  // Clone, branch, commit, push.
  await ok('cd /workspace && git clone -q git://git/repo.git repo && cd repo && test "$(cat README.md)" = "# Integration Test"')
  await ok(`cd /workspace/repo && git checkout -q -b agent/t1 && echo "line from t1" >> README.md && echo hi > t1.txt \
    && git add -A && git commit -q -m "t1 work" && git push -q origin agent/t1`)

  // Pushing to main must be rejected by the pre-receive hook.
  const rej = await run('cd /workspace/repo && git push origin agent/t1:main')
  assert.notEqual(rej.exitCode, 0)
  assert.ok(rej.stderr.includes(PROTECTED_MESSAGE), rej.stderr)
  const rej2 = await run('cd /workspace/repo && git push --force origin agent/t1:refs/heads/main')
  assert.notEqual(rej2.exitCode, 0)

  // Conflicting branch from the original main.
  await ok(`cd /workspace/repo && git checkout -q -b agent/conflict origin/main && echo "other line" >> README.md \
    && git commit -q -am "conflicting work" && git push -q origin agent/conflict`)

  const branches = await d.listBranches(slug)
  const t1 = branches.find((b) => b.name === 'agent/t1')
  assert.ok(t1, JSON.stringify(branches))
  assert.equal(t1.aheadOfMain, 1)
  assert.equal(t1.behindMain, 0)
  assert.equal(branches.find((b) => b.name === 'main')?.sha, main0, 'main untouched by rejected pushes')

  const diff = await d.diff(slug, 'agent/t1')
  assert.match(diff, /\+line from t1/)
  assert.match(diff, /t1\.txt/)
  await assert.rejects(d.diff(slug, 'nope'), /no such branch/)
  await assert.rejects(d.diff(slug, '--output=/tmp/x'), /invalid branch/)

  // Merge succeeds and main advances to a merge commit.
  const m = await d.mergeToMain(slug, 'agent/t1', 'Merge agent/t1 (approved)')
  assert.equal(m.ok, true, m.message)
  assert.ok(m.ok)
  assert.notEqual(m.sha, main0)
  const after = await d.listBranches(slug)
  assert.equal(after.find((b) => b.name === 'main')?.sha, m.sha)
  assert.equal(after.find((b) => b.name === 'agent/t1')?.aheadOfMain, 0)
  const parents = await d.exec(`colony-git-${slug}`, ['git', '-C', '/srv/git/repo.git', 'log', '-1', '--format=%P%n%s', 'main'])
  const [p, subject] = parents.stdout.trim().split('\n')
  assert.equal(p.split(' ').length, 2, 'no-ff merge commit has two parents')
  assert.equal(subject, 'Merge agent/t1 (approved)')

  // Merging again: already merged, main unchanged.
  const again = await d.mergeToMain(slug, 'agent/t1', 'again')
  assert.ok(again.ok && again.sha === m.sha, again.message)

  // Conflict: reported, main unchanged, worktree cleaned up.
  const c = await d.mergeToMain(slug, 'agent/conflict', 'Merge agent/conflict')
  assert.equal(c.ok, false)
  assert.ok(!c.ok && c.conflict, c.message)
  assert.equal((await d.listBranches(slug)).find((b) => b.name === 'main')?.sha, m.sha)
  const wt = await d.exec(`colony-git-${slug}`, ['git', '-C', '/srv/git/repo.git', 'worktree', 'list', '--porcelain'])
  assert.equal(wt.stdout.match(/^worktree /gm)?.length, 1, wt.stdout)

  // Injection attempts never reach a shell.
  await assert.rejects(d.mergeToMain(slug, 'x;touch /tmp/pwned', 'm'), /invalid branch/)
  const nob = await d.mergeToMain(slug, 'agent/missing', 'm')
  assert.deepEqual(nob, { ok: false, conflict: false, message: 'no such branch: agent/missing' })

  // The agent sees the merged main.
  await ok('cd /workspace/repo && git fetch -q origin && test "$(git rev-parse origin/main)" = "' + m.sha + '"')

  const st = await d.agentStats(agentId)
  assert.ok(st && st.running)
  assert.equal(typeof st.cpuPct, 'number')
  assert.ok(Number.isFinite(st.cpuPct) && st.cpuPct >= 0)
  assert.ok(st.memMb > 0, JSON.stringify(st))
  assert.equal(st.memLimitMb, 512)

  const listed = (await d.listContainers()).filter((x) => x.projectSlug === slug)
  assert.deepEqual(listed.map((x) => [x.kind, x.running, x.agentId]).sort(), [
    ['agent', true, agentId], ['git', true, undefined],
  ])

  // Restart semantics: startAgent recreates, workspace volume survives.
  await d.stopAgent(agentId)
  assert.equal((await d.agentStats(agentId))?.running, false)
  await d.startAgent({ agentId, projectSlug: slug, image: 'colony-agent:dev', env: {}, memoryMb: 512, cpus: 1 })
  await ok('test -d /workspace/repo/.git')
  await d.stopAgent(agentId, { remove: true })
  assert.equal(await d.agentStats(agentId), null)

  // Purge leaves nothing behind.
  await d.removeProject(slug, { purge: true })
  assert.equal((await d.listContainers()).filter((x) => x.projectSlug === slug).length, 0)
  const vols = (await docker.listVolumes()).Volumes ?? []
  assert.deepEqual(vols.filter((v) => v.Name.includes(id)).map((v) => v.Name), [])
  const nets = await docker.listNetworks()
  assert.deepEqual(nets.filter((n) => n.Name.includes(id)).map((n) => n.Name), [])
})
