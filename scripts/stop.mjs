#!/usr/bin/env node
// `npm run stop`: shuts Colony down cleanly.
//   1. pauses every agent (they stop after their current step),
//   2. stops every base's dev Supabase stack,
//   3. asks the control plane to exit (POST /api/admin/shutdown); `npm start` then exits too,
//   4. stops the remaining colony-agent-* and colony-git-* containers.
// Only containers whose names start with colony-agent- / colony-git- are touched.
// `npm start` brings everything back; agents resume where they left off.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.COLONY_PORT || 7700)
const BASE = `http://127.0.0.1:${PORT}`
const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const say = (s) => console.log(`${paint('33', '[colony]')} ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readEnvKey(key) {
  if (process.env[key]) return process.env[key]
  const p = join(root, '.env')
  if (!existsSync(p)) return undefined
  const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'))
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined
}

function adminToken() {
  const dir = readEnvKey('COLONY_DATA_DIR')
  const file = join(dir ? resolve(root, dir) : join(root, '.colony'), 'admin-token')
  if (readEnvKey('COLONY_ADMIN_TOKEN')) return readEnvKey('COLONY_ADMIN_TOKEN')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
}

const token = adminToken()
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, signal: AbortSignal.timeout(15_000),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}

function docker(args) {
  return new Promise((resolveP) => {
    execFile('docker', args, { windowsHide: true, timeout: 60_000 }, (err, stdout) => resolveP(err ? null : String(stdout).trim()))
  })
}

const summary = { paused: 0, supabase: [], controlPlane: 'was not running', containers: [] }

// ── control plane ────────────────────────────────────────────────────────────
let cpUp = false
try { cpUp = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok } catch { /* not running */ }

if (!cpUp) {
  say('The control plane is not running; only stopping leftover containers.')
} else {
  if (!token) say(paint('33', 'No admin token found (.colony/admin-token); requests may be refused.'))
  try {
    say('Pausing all agents…')
    const r = await api('POST', '/api/agents/pause-all')
    summary.paused = r?.paused?.length ?? 0
    // Let them finish their current step (up to 10 s).
    for (let i = 0; i < 20; i++) {
      const snap = await api('GET', '/api/snapshot')
      if (!snap.agents.some((a) => a.pauseRequested && a.status !== 'paused' && a.status !== 'error' && a.status !== 'done')) break
      await sleep(500)
    }

    const snap = await api('GET', '/api/snapshot')
    const stacks = snap.projects.filter((p) => ['running', 'provisioning', 'error'].includes(p.supabase?.status))
    for (const p of stacks) {
      say(`Stopping dev Supabase for ${p.name}…`)
      try { await api('POST', `/api/projects/${encodeURIComponent(p.id)}/supabase/stop`) } catch (e) { say(paint('31', String(e.message))) }
    }
    for (let i = 0; i < 90 && stacks.length; i++) {
      const d = await Promise.all(stacks.map((p) => api('GET', `/api/projects/${encodeURIComponent(p.id)}/supabase`).catch(() => undefined)))
      if (d.every((x) => !x || ['stopped', 'none', 'error'].includes(x.status))) { summary.supabase = stacks.map((p) => p.name); break }
      await sleep(1000)
    }

    say('Shutting down the control plane…')
    await api('POST', '/api/admin/shutdown')
    for (let i = 0; i < 30; i++) {
      try { await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) }) } catch { summary.controlPlane = 'stopped'; break }
      await sleep(500)
    }
    if (summary.controlPlane !== 'stopped') summary.controlPlane = 'asked to stop (still answering)'
  } catch (e) {
    say(paint('31', `Control plane shutdown did not complete: ${e.message}`))
    summary.controlPlane = 'error (see above)'
  }
}

// ── containers ───────────────────────────────────────────────────────────────
const listed = await docker(['ps', '--format', '{{.Names}}'])
if (listed === null) {
  say(paint('33', 'Docker is not reachable; skipped stopping containers.'))
} else {
  const names = listed.split(/\r?\n/).map((s) => s.trim()).filter((n) => /^colony-(agent|git)-/.test(n))
  if (names.length) {
    say(`Stopping ${names.length} container${names.length === 1 ? '' : 's'}…`)
    await docker(['stop', ...names])
    summary.containers = names
  }
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('')
say(paint('32', 'Colony is stopped.'))
console.log(`  agents paused:      ${cpUp ? summary.paused : 'n/a'}`)
console.log(`  dev Supabase:       ${summary.supabase.length ? summary.supabase.join(', ') : 'none running'}`)
console.log(`  control plane:      ${summary.controlPlane}`)
console.log(`  containers stopped: ${summary.containers.length ? summary.containers.join(', ') : 'none'}`)
console.log('  Run `npm start` to bring it all back; agents resume where they left off.')
