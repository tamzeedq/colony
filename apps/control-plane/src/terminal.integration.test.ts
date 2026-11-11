// Terminal WebSocket + hand-back against the local Docker engine with the real driver.
// Runs only with COLONY_DOCKER_TESTS=1 (needs the colony-agent:dev image). Agent containers
// run `sleep infinity` instead of the runner, so no Claude Code is started.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { Agent, Project } from '@colony/shared'
import { createApp } from './app'
import { loadConfig, REPO_ROOT } from './config'
import { createDockerDriver } from './infra/docker'

const enabled = process.env.COLONY_DOCKER_TESTS === '1'
const ADMIN = 'integration-admin-token'

test('terminal and hand-back against a real agent container', { skip: !enabled && 'set COLONY_DOCKER_TESTS=1', timeout: 300_000 }, async (t) => {
  const id = randomBytes(3).toString('hex')
  const dir = mkdtempSync(join(tmpdir(), 'colony-it-term-'))
  const infra = createDockerDriver({ agentCmd: ['sleep', 'infinity'] })
  const config = loadConfig({}, {
    dataDir: dir, dbPath: join(dir, 'colony.db'), rolesDir: join(REPO_ROOT, 'roles'),
    oauthToken: 'sk-ant-oat-not-real', adminToken: ADMIN, port: 0, bind: '127.0.0.1',
    agentMemoryMb: 512, agentCpus: 1,
  })
  const app = await createApp({ config, infra, poll: false, quiet: true })
  const port = await app.start(0, '127.0.0.1')
  const base = `http://127.0.0.1:${port}`
  const slug = `it-term-${id}`
  t.after(async () => {
    await app.close().catch(() => {})
    await infra.removeProject(slug, { purge: true }).catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  const api = async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${ADMIN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    assert.ok(res.ok, `${method} ${path}: ${res.status} ${text}`)
    return JSON.parse(text) as T
  }

  const project = await api<Project>('POST', '/api/projects', { name: slug })
  const agent = await api<Agent>('POST', `/api/projects/${project.id}/agents`, { role: 'backend' })
  const container = `colony-agent-${agent.id}`

  // ── terminal ──
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agents/${agent.id}/terminal?token=${ADMIN}&cols=120&rows=40`)
  let out = ''
  ws.on('message', (d: Buffer) => { out += d.toString('utf8') })
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  const waitOut = async (re: RegExp, ms = 15_000) => {
    const end = Date.now() + ms
    while (!re.test(out)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${re} in ${JSON.stringify(out.slice(-500))}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  // The tty echoes the command line, so the markers are built by the shell (O""K, $((…))).
  ws.send(Buffer.from('echo O""K-$((40+2)) && whoami && pwd && tput cols\r'), { binary: true })
  await waitOut(/OK-42\r?\nnode\r?\n\/workspace\r?\n120/)
  ws.send(JSON.stringify({ type: 'resize', cols: 101, rows: 33 }))
  await new Promise((r) => setTimeout(r, 300))
  ws.send(Buffer.from('echo SIZE-$(stty size | tr " " x)\r'), { binary: true })
  await waitOut(/SIZE-33x101/)
  ws.send(Buffer.from('sleep 777\r'), { binary: true })
  await new Promise((r) => setTimeout(r, 500))

  const procs = async () => (await infra.exec(container, ['sh', '-c',
    'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done'])).stdout
  assert.match(await procs(), /sleep 777/)
  ws.close()
  assert.equal(await closed, 1005) // client-initiated close without a code
  // The shell (and its job) are killed from a second exec: SIGHUP, SIGKILL after 2 s.
  const end = Date.now() + 10_000
  let left = await procs()
  while (/sleep 777|bash -l/.test(left) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200))
    left = await procs()
  }
  assert.doesNotMatch(left, /sleep 777|bash -l/, 'no shell left behind')
  const events = await api<{ text: string }[]>('GET', `/api/agents/${agent.id}/events`)
  assert.ok(events.some((e) => e.text === 'Terminal opened'))
  assert.ok(events.some((e) => e.text === 'Terminal closed'))

  // ── take control / hand back with real git output from the container ──
  const init = await infra.exec(container, ['sh', '-c',
    'cd /workspace && git init -q && echo a > a.txt && git add a.txt && git -c user.email=t@t -c user.name=t commit -q -m init && echo b >> a.txt && echo new > new.txt'])
  assert.equal(init.exitCode, 0, init.stderr)
  const taken = await api<Agent>('POST', `/api/agents/${agent.id}/take-control`)
  assert.equal(taken.controller, 'you')
  const back = await api<{ agent: Agent; message: string }>('POST', `/api/agents/${agent.id}/hand-back`, { note: 'edited a.txt' })
  assert.equal(back.agent.controller, 'agent')
  assert.match(back.message, /a\.txt \| 1 \+/)
  assert.match(back.message, / M a\.txt/)
  assert.match(back.message, /\?\? new\.txt/)
  assert.match(back.message, /Their note: edited a\.txt/)

  // ── clean up through the API: removes containers, network and volumes ──
  await api('DELETE', `/api/projects/${project.id}?purge=1`)
  const left2 = await infra.docker.listContainers({ all: true, filters: { label: [`colony.project=${slug}`] } })
  assert.equal(left2.length, 0)
})
