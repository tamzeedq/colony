// Ops Deck dev server for `npm start` (scripts/start.mjs): Vite through its JS API, plus a
// watchdog that exits when the launcher is gone (so a killed launcher leaves no orphan on :5173).
// usage: node scripts/ui-server.mjs <port>
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const uiDir = join(root, 'apps', 'ui')
const port = Number(process.argv[2] || 5173)

// Resolve vite the way apps/ui does.
const require = createRequire(join(uiDir, 'package.json'))
const viteDir = dirname(require.resolve('vite/package.json'))
const { createServer } = await import(pathToFileURL(join(viteDir, 'dist', 'node', 'index.js')).href)

const server = await createServer({ root: uiDir, configFile: join(uiDir, 'vite.config.ts'), server: { port, strictPort: true } })
await server.listen()
server.printUrls()

let closing = false
async function stop(code = 0) {
  if (closing) return
  closing = true
  setTimeout(() => process.exit(code), 3000).unref()
  try { await server.close() } finally { process.exit(code) }
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())

const launcher = Number(process.env.COLONY_LAUNCHER_PID)
if (Number.isInteger(launcher) && launcher > 0) {
  const t = setInterval(() => {
    try { process.kill(launcher, 0) } catch (e) { if (e.code === 'ESRCH') { clearInterval(t); void stop() } }
  }, 2000)
  t.unref()
}
