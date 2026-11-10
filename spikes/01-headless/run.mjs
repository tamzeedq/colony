// Phase 0 spike: run Claude Code headless in a container with the subscription
// token, stream its events, and inject a second user message mid-run.
//
//   npm run agent:image
//   npm run spike:headless            (reads CLAUDE_CODE_OAUTH_TOKEN from env or .env)
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'

const ROOT = new URL('../../', import.meta.url)
function loadEnv() {
  const p = new URL('.env', ROOT)
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
loadEnv()
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error('Missing CLAUDE_CODE_OAUTH_TOKEN. See .env.example.')
  process.exit(1)
}

const model = process.argv[2] ?? 'sonnet'
const args = [
  'run', '--rm', '-i',
  '--name', `colony-spike-${Date.now()}`,
  '--memory', '2g', '--cpus', '2',
  '-e', 'CLAUDE_CODE_OAUTH_TOKEN',
  'colony-agent:dev',
  'claude', '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
  '--model', model,
]

const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
const send = (text) =>
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')

send('Create hello.py in the current directory that prints the first 10 Fibonacci numbers, run it, and show the output.')

let nudged = false
const t0 = Date.now()
mkdirSync(new URL('.colony/', ROOT), { recursive: true })
const raw = createWriteStream(new URL('.colony/spike-headless.jsonl', ROOT))
const rl = createInterface({ input: child.stdout })
rl.on('line', (line) => {
  raw.write(line + '\n')
  let ev
  try { ev = JSON.parse(line) } catch { console.log('[raw]', line); return }
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(5)
  if (ev.type === 'system') console.log(`${s}s system/${ev.subtype}`, ev.model ?? '', ev.session_id ?? '')
  else if (ev.type === 'assistant') {
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'text') console.log(`${s}s text     ${b.text.slice(0, 160)}`)
      else if (b.type === 'thinking') console.log(`${s}s thinking ${String(b.thinking ?? '').slice(0, 120)}`)
      else if (b.type === 'tool_use') console.log(`${s}s tool     ${b.name} ${JSON.stringify(b.input).slice(0, 140)}`)
    }
    // Mid-run injection test: nudge once, after the first assistant event.
    if (!nudged) {
      nudged = true
      console.log(`${s}s >>> nudge injected`)
      send('Also add a comment at the top of hello.py saying "written by a Colony agent".')
    }
  } else if (ev.type === 'user') {
    for (const b of ev.message?.content ?? []) if (b.type === 'tool_result') {
      const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
      console.log(`${s}s result   ${out.replace(/\s+/g, ' ').slice(0, 140)}`)
    }
  } else if (ev.type === 'result') {
    console.log(`${s}s RESULT   ${ev.subtype} turns=${ev.num_turns} cost=$${ev.total_cost_usd} usage=${JSON.stringify(ev.usage ?? {})}`)
    // Result after the nudge was handled: close input so the CLI exits.
    if (nudged && ev.num_turns > 1) child.stdin.end()
  } else console.log(`${s}s ${ev.type}`, JSON.stringify(ev).slice(0, 160))
})

setTimeout(() => { console.error('Timeout after 5 min'); child.kill() }, 5 * 60_000).unref()
child.on('exit', (code) => console.log(`container exited ${code}`))
