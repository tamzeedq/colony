#!/usr/bin/env node
// `npm run e2e:agents`: one real end-to-end run of Colony with real agents (iteration 1 #3).
//
// It needs a running Colony (`npm start`) and spends a little of your Claude subscription:
// a Sonnet orchestrator plus Haiku workers on a throwaway base with a tiny goal. It checks the
// whole loop: plan → staff → work → QA verification → team check-in → merge request → merge →
// quest done + XP. The merge itself waits for YOU in the Inbox: Colony never merges without a
// recorded human approval, and neither does this script. Plan approval on the throwaway base is
// answered by the script (you started it). The base is deleted afterwards unless --keep.
//
// Options: --keep (leave the base), --timeout-min N (per stage, default 12), --yes (no prompt).

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const KEEP = args.has('--keep')
const tIdx = process.argv.indexOf('--timeout-min')
const STAGE_MS = (tIdx > 0 ? Number(process.argv[tIdx + 1]) : 12) * 60_000
const PORT = Number(process.env.COLONY_PORT || 7700)
const BASE = `http://127.0.0.1:${PORT}`

const say = (s) => console.log(`[e2e] ${s}`)
const fail = (s) => { console.error(`[e2e] ✕ ${s}`); process.exitCode = 1 }

function token() {
  if (process.env.COLONY_ADMIN_TOKEN) return process.env.COLONY_ADMIN_TOKEN
  const p = join(process.env.COLONY_DATA_DIR || join(root, '.colony'), 'admin-token')
  if (!existsSync(p)) throw new Error('no admin token found; start Colony with `npm start` first')
  return readFileSync(p, 'utf8').trim()
}
const T = token()
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { authorization: `Bearer ${T}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`)
  return json
}
const snap = () => api('GET', '/api/snapshot')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll the snapshot until `pred` returns a truthy value (or the stage times out). */
async function until(label, pred, ms = STAGE_MS) {
  const end = Date.now() + ms
  let last = ''
  for (;;) {
    const s = await snap()
    const v = await pred(s)
    if (v) { say(`✓ ${label}`); return v }
    const line = s.agents.filter((a) => a.projectId === projectId).map((a) => `${a.callsign}:${a.status}`).join(' ')
    if (line !== last) { say(`… ${label} (${line || 'no agents yet'})`); last = line }
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`)
    await sleep(5000)
  }
}

let projectId = ''
let prevCheckMinutes  // the commander's own check-in interval, restored at the end
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); say(`${ok ? '✓' : '✕'} ${name}${detail ? ` — ${detail}` : ''}`) }

async function main() {
  try { await api('GET', '/api/health') } catch { throw new Error(`Colony isn't reachable on ${BASE}; run \`npm start\` first`) }
  if (!args.has('--yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const a = await rl.question('[e2e] This creates a throwaway base and runs real agents (a Sonnet orchestrator + Haiku workers) on your subscription, a few minutes of light usage. You will approve one merge in the Inbox. Continue? [y/N] ')
    rl.close()
    if (!/^y/i.test(a.trim())) { say('cancelled'); return }
  }
  const before = await snap()
  prevCheckMinutes = before.guards?.teamCheckMinutes ?? 5
  // Check-ins every 2 minutes for this run so we see at least one; restored at the end.
  await api('PATCH', '/api/guards', { teamCheckMinutes: 2 })

  const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')
  const goal = [
    'Add a tiny utility with tests. Plan exactly two quests and staff each with a Haiku worker:',
    'Quest A: create src/slug.js (ES module) exporting slugify(text) that lowercases, trims and replaces runs of non-alphanumerics with single hyphens. Acceptance: a node:test file test/slug.test.js passes (agent-checkable).',
    'Quest B (depends on A): add a package.json with "type": "module" and a "test": "node --test" script, and a README section documenting slugify. Acceptance: `npm test` passes (agent-checkable); the README wording reads well (commander checks).',
    'Have a QA worker verify each quest before requesting the merge. Do not merge yourself.',
  ].join(' ')
  const project = await api('POST', '/api/projects', { name: `E2E ${stamp}`, goal })
  projectId = project.id
  say(`base ${project.name} (${projectId})`)
  await api('POST', `/api/projects/${projectId}/agents`, { role: 'orchestrator', model: 'sonnet-5.5', budgetCapUsd: 2 })

  // 1. Plan: the kickoff asks for plan approval; answer it (this is the commander's own test base).
  const planAlert = await until('orchestrator asks to approve its plan', (s) =>
    s.alerts.find((a) => a.projectId === projectId && a.kind === 'question' && !a.resolvedAt))
  const orch = (await snap()).agents.find((a) => a.projectId === projectId && a.role === 'orchestrator')
  await api('POST', `/api/agents/${orch.id}/message`, { text: 'Approve plan. Go ahead.' })
  await api('POST', `/api/alerts/${planAlert.id}/resolve`, { resolution: 'acted' })

  // 2. Staffing and quests.
  await until('two quests exist, B depends on A', (s) => {
    const qs = s.quests.filter((q) => q.projectId === projectId)
    return qs.length >= 2 && qs.some((q) => q.dependsOn.length > 0)
  })
  await until('a worker is spawned', (s) => s.agents.some((a) => a.projectId === projectId && a.role !== 'orchestrator'))

  // 3. First merge request, after QA verification; the human approves it.
  for (let n = 1; n <= 2; n++) {
    const mr = await until(`merge request ${n} is waiting for you`, (s) =>
      s.mergeRequests.find((m) => m.projectId === projectId && m.status === 'pending'))
    const q = (await snap()).quests.find((x) => x.id === mr.questId)
    const agentItems = (q?.acceptance ?? []).filter((a) => (a.check ?? 'agent') === 'agent')
    const verified = agentItems.filter((a) => a.verification?.result === 'pass' && a.verification.by !== 'you')
    check(`quest "${q?.title ?? mr.questId}" verified by a QA agent before review`, agentItems.length > 0 && verified.length === agentItems.length,
      `${verified.length}/${agentItems.length} agent-checkable criteria passed`)
    say(`→ Open the Colony Inbox and click "Approve & merge" on "Merge ${mr.branch} → main?" (this script never approves merges).`)
    await until(`you approved and Colony merged ${mr.branch}`, async (s) => s.mergeRequests.find((m) => m.id === mr.id && m.status === 'merged'), STAGE_MS * 2)
  }

  // 4. Outcomes.
  const end = await snap()
  const qs = end.quests.filter((q) => q.projectId === projectId)
  check('both quests are done', qs.length >= 2 && qs.every((q) => q.status === 'done' || q.status === 'failed') && qs.filter((q) => q.status === 'done').length >= 2)
  const events = end.events.filter((e) => e.projectId === projectId)
  check('a team check-in reached the orchestrator', events.some((e) => /Team check sent/.test(e.text)))
  check('XP was awarded', end.agents.filter((a) => a.projectId === projectId).some((a) => a.xp > 0 || a.level > 1) || events.some((e) => e.kind === 'quest_complete' && /XP/.test(e.text)))
  const spend = end.projects.find((p) => p.id === projectId)?.spendTodayUsd ?? 0
  say(`usage for this run: ~$${spend.toFixed(2)} equivalent (counts against your subscription limits, not billed)`)

}

main().catch((e) => fail(e.message)).finally(async () => {
  if (prevCheckMinutes !== undefined) await api('PATCH', '/api/guards', { teamCheckMinutes: prevCheckMinutes }).catch(() => {})
  if (projectId && !KEEP) {
    try { await api('DELETE', `/api/projects/${projectId}?purge=1`); say('throwaway base deleted') } catch (e) { say(`couldn't delete the base: ${e.message}`) }
  } else if (projectId) say(`kept base ${projectId} (--keep)`)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n[e2e] ${results.length - bad.length}/${results.length} checks passed${bad.length ? `: failed ${bad.map((b) => b.name).join('; ')}` : ''}`)
  if (bad.length) process.exitCode = 1
})
