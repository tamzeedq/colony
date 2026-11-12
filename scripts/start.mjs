#!/usr/bin/env node
// `npm start`: runs Colony (control plane on :7700 + Ops Deck UI on :5173) in one terminal.
// Checks the prerequisites first, prefixes each process's output, and stops both on Ctrl+C.
// Agent containers and dev Supabase stacks keep running when Colony stops; the next start
// reconnects to them.

import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CP_PORT = Number(process.env.COLONY_PORT || 7700)
const UI_PORT = 5173
const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const say = (s) => console.log(`${paint('33', '[colony]')} ${s}`)
const fail = (s) => { console.error(`${paint('31', '[colony]')} ${s}`); process.exit(1) }

function connects(port, host) {
  return new Promise((resolve) => {
    const s = createConnection({ port, host })
    s.setTimeout(1500, () => { s.destroy(); resolve(false) })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}
/** Vite listens on `localhost`, which is ::1 only on some Windows setups: check both families. */
async function portInUse(port) {
  return (await connects(port, '127.0.0.1')) || (await connects(port, '::1'))
}
async function ok(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()))
  })
}

function readEnvKey(key) {
  if (process.env[key]) return process.env[key]
  const p = join(root, '.env')
  if (!existsSync(p)) return undefined
  const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'))
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined
}

/** Windows: find Docker Desktop (per-user or machine-wide install), start it, and wait for the
 *  engine. Returns the server version, or null. COLONY_NO_DOCKER_START=1 turns this off. */
async function startDockerDesktop() {
  if (process.platform !== 'win32' || process.env.COLONY_NO_DOCKER_START === '1') return null
  const candidates = []
  const cli = await run('where', ['docker'])
  // <install>/resources/bin/docker.exe -> <install>/Docker Desktop.exe
  for (const p of (cli ?? '').split(/\r?\n/).filter(Boolean)) candidates.push(join(dirname(p), '..', '..', 'Docker Desktop.exe'))
  for (const base of [process.env.ProgramFiles, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(join(base, 'Docker', 'Docker', 'Docker Desktop.exe'), join(base, 'DockerDesktop', 'Docker Desktop.exe'))
  }
  const exe = candidates.find((c) => existsSync(c))
  if (!exe) return null
  say('Docker is not running; starting Docker Desktop (this can take a minute)…')
  spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  for (let waited = 0; waited < 180; waited += 3) {
    await new Promise((r) => setTimeout(r, 3000))
    const v = await run('docker', ['version', '--format', '{{.Server.Version}}'])
    if (v) { say(`Docker Desktop is up after ~${waited + 3} s.`); return v }
    if (waited && waited % 30 === 0) say(`Still waiting for Docker Desktop (${waited} s)…`)
  }
  return null
}

// ── prerequisites ──────────────────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number)
if (major < 22) fail(`Node 22 or newer is required (this is ${process.versions.node}).`)
if (!existsSync(join(root, 'node_modules'))) fail('Dependencies are missing. Run `npm install` first.')

if (await portInUse(CP_PORT) || await portInUse(UI_PORT)) {
  fail(`Port ${CP_PORT} or ${UI_PORT} is already in use. Colony may already be running (open http://localhost:${UI_PORT}), or stop whatever holds the port.`)
}

let dockerVersion = await run('docker', ['version', '--format', '{{.Server.Version}}'])
if (!dockerVersion) dockerVersion = await startDockerDesktop()
if (!dockerVersion) fail('Docker is not reachable. Start Docker Desktop and try again.')
const image = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', 'colony-agent:dev'])
if (!image) say(paint('33', 'The agent image colony-agent:dev is missing; agents cannot start until you run `npm run agent:image`.'))
if (!readEnvKey('CLAUDE_CODE_OAUTH_TOKEN')) {
  say(paint('33', 'CLAUDE_CODE_OAUTH_TOKEN is not set in .env; agents cannot start until it is (`docker run --rm -it colony-agent:dev claude setup-token`).'))
}

// ── processes ─────────────────────────────────────────────────────────────────
const children = []
let stopping = false

function start(name, tint, cwd, args, env = {}) {
  const child = spawn(process.execPath, args, {
    // COLONY_LAUNCHER_PID: both servers exit if this launcher disappears (window closed, killed).
    cwd, env: { ...process.env, ...(color ? { FORCE_COLOR: '1' } : { NO_COLOR: '1', FORCE_COLOR: '0' }), COLONY_LAUNCHER_PID: String(process.pid), ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const prefix = paint(tint, `[${name}]`.padEnd(6))
  for (const stream of [child.stdout, child.stderr]) {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) console.log(`${prefix} ${line}`)
    })
  }
  child.on('exit', (code, signal) => {
    if (stopping) return
    say(paint('31', `${name} exited (${signal ?? `code ${code}`}); stopping Colony.`))
    shutdown(code || 1)
  })
  children.push(child)
  return child
}

function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  say('Stopping. Agent containers and dev Supabase stacks keep running; the next `npm start` reconnects to them.')
  for (const c of children) if (c.exitCode === null) c.kill()
  setTimeout(() => process.exit(code), 3000).unref()
  Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.once('exit', r))))).then(() => process.exit(code))
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
// If whatever started us (npm, a shell) is killed without signalling us, stop too; the servers
// watch this process the same way (COLONY_LAUNCHER_PID), so nothing is left holding the ports.
const parent = process.ppid
const parentWatch = setInterval(() => {
  try { process.kill(parent, 0) } catch (e) { if (e.code === 'ESRCH') { clearInterval(parentWatch); shutdown(0) } }
}, 2000)
parentWatch.unref()

say(`Docker ${dockerVersion} · starting the control plane on :${CP_PORT}, then the Ops Deck on :${UI_PORT}`)
start('cp', '36', join(root, 'apps', 'control-plane'), ['--import', 'tsx', 'src/main.ts'], { COLONY_LOG_LEVEL: process.env.COLONY_LOG_LEVEL || 'warn' })

// The UI proxies /api to the control plane, so start it once the control plane answers.
let cpUp = false
for (const end = Date.now() + 90_000; Date.now() < end && !stopping; await sleep(500)) {
  if (await ok(`http://127.0.0.1:${CP_PORT}/api/health`)) { cpUp = true; break }
}
if (stopping) await new Promise(() => {})
if (!cpUp) { say(paint('31', 'The control plane did not answer within 90 s; check the output above.')); shutdown(1) }
else {
  start('ui', '35', join(root, 'apps', 'ui'), [join(root, 'scripts', 'ui-server.mjs'), String(UI_PORT)])
  let uiUp = false
  for (const end = Date.now() + 60_000; Date.now() < end && !stopping; await sleep(500)) {
    if (await ok(`http://localhost:${UI_PORT}/`)) { uiUp = true; break }
  }
  if (uiUp) say(paint('32', `Colony is running. The first time, open the "Open the Ops Deck" link above to pair this browser; after that, http://localhost:${UI_PORT}. Ctrl+C stops it.`))
  else if (!stopping) say(paint('33', 'The Ops Deck did not answer within 60 s; check the output above.'))
}
