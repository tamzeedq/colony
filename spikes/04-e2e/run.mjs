// Phase 1 end-to-end: control plane + Docker driver + runner + real Claude Code.
//   1. start the control plane:  COLONY_DATA_DIR=<dir> npm run start -w @colony/control-plane
//   2. node spikes/04-e2e/run.mjs <dataDir> [--keep]
// Creates a project, spawns a Haiku backend agent, has it commit + push a branch, then
// checks main is protected until a merge request is approved, and cleans up.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

const dataDir = process.argv[2] ?? '.colony'
const keep = process.argv.includes('--keep')
const BASE = process.env.COLONY_URL ?? 'http://127.0.0.1:7700'
const token = readFileSync(join(dataDir, 'admin-token'), 'utf8').trim()
const H = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
const t0 = Date.now()
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a)
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }

async function api(method, path, body, headers = H) {
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: r.status, json }
}

// 0. auth is enforced
const noauth = await api('GET', '/api/snapshot', undefined, {})
log('snapshot without admin token →', noauth.status)
if (noauth.status !== 401) fail('snapshot should require the admin token')

// UI stream
const ws = new WebSocket(BASE.replace('http', 'ws') + `/api/stream?token=${token}`)
const seen = { kinds: new Map(), statuses: [], planUsage: null, events: 0 }
let agentId
ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.type === 'event' && m.event.agentId === agentId) {
    seen.events++
    seen.kinds.set(m.event.kind, (seen.kinds.get(m.event.kind) ?? 0) + 1)
    log(`  event ${m.event.kind.padEnd(8)} ${String(m.event.text).slice(0, 90)}`)
  } else if (m.type === 'agent_delta' && m.agentId === agentId && m.patch.status) {
    if (seen.statuses.at(-1) !== m.patch.status) { seen.statuses.push(m.patch.status); log(`  status → ${m.patch.status}`) }
  } else if (m.type === 'resources' && m.resources.usage?.source === 'connected') {
    seen.planUsage = m.resources.usage
  }
})
await new Promise((r) => ws.once('open', r))

let projectId
try {
  // 1. project
  const p = await api('POST', '/api/projects', { name: `E2E ${Date.now() % 100000}`, goal: 'Phase 1 end-to-end test', stack: ['node'] })
  log('create project →', p.status, p.json.id ?? p.json)
  if (p.status !== 201) throw new Error('project create failed')
  projectId = p.json.id

  // 2. agent with a task
  const task = 'Create a file named colony-e2e.txt containing exactly the line "hello from a Colony agent". Commit it with message "Add colony-e2e.txt" and push your current branch to origin. Then reply DONE.'
  const a = await api('POST', `/api/projects/${projectId}/agents`, { role: 'backend', model: 'haiku-5.5', task, budgetCapUsd: 2 })
  log('spawn agent →', a.status, a.json.id ?? a.json, a.json.callsign ?? '', a.json.branch ?? '')
  if (a.status !== 201) throw new Error('spawn failed')
  agentId = a.json.id
  const branch = a.json.branch

  // 3. wait for the turn to finish
  const deadline = Date.now() + 4 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    if (seen.statuses.includes('error')) throw new Error('agent went to error')
    const done = seen.kinds.get('status') >= 2 && seen.statuses.at(-1) === 'idle' && seen.events > 3
    if (done) break
  }
  log('turn finished; statuses:', seen.statuses.join(' → '))
  log('event kinds:', JSON.stringify(Object.fromEntries(seen.kinds)))
  log('plan usage via stream:', seen.planUsage ? `session ${seen.planUsage.session.usedPct}% · weekly ${seen.planUsage.weekly.usedPct}%` : 'none')

  // 4. branch pushed?
  const br = await api('GET', `/api/projects/${projectId}/branches`)
  const mine = (br.json.branches ?? br.json).find?.((b) => b.name === branch)
  log('branches →', JSON.stringify(br.json).slice(0, 200))
  if (!mine || mine.aheadOfMain < 1) throw new Error(`branch ${branch} not pushed / not ahead of main`)

  // 5. merge request: approve merges into main
  const mr = await api('POST', '/api/merge-requests', { projectId, branch, requestedBy: agentId })
  log('merge request →', mr.status, mr.json.id, mr.json.status)
  const ap = await api('POST', `/api/merge-requests/${mr.json.id}/approve`)
  log('approve →', ap.status, JSON.stringify(ap.json).slice(0, 200))
  const br2 = await api('GET', `/api/projects/${projectId}/branches`)
  const after = (br2.json.branches ?? br2.json).find((b) => b.name === branch)
  log('after merge, branch ahead of main:', after?.aheadOfMain)
  if (ap.status !== 200 || after?.aheadOfMain !== 0) fail('approved merge did not land on main')

  // 6. agent snapshot sanity
  const snap = await api('GET', '/api/snapshot')
  const ag = snap.json.agents.find((x) => x.id === agentId)
  log('agent in snapshot:', JSON.stringify({ status: ag.status, spend: ag.spendTodayUsd, tokens: ag.tokensToday, branch: ag.branch, mem: ag.container?.memMb }))
  if (!(ag.spendTodayUsd > 0)) fail('usage was not recorded')
  if (!process.exitCode) log('PASS')
} catch (e) {
  fail(e.message)
} finally {
  ws.close()
  if (projectId && !keep) {
    const d = await api('DELETE', `/api/projects/${projectId}?purge=1`)
    log('cleanup: delete project →', d.status)
  }
}
