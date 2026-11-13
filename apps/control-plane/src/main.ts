// Colony control plane entry point: `npm run dev -w @colony/control-plane`.

import { join } from 'node:path'
import { ensureAdminToken, pairingLink } from './admin'
import { createApp } from './app'
import { loadConfig } from './config'
import { createDockerDriver } from './infra/docker'
import { createCliSupabaseDriver } from './infra/supabase'

// Agent containers can reach the host port (even a loopback-only bind, via Docker Desktop), so
// the REST API and UI stream always require an admin token (admin.ts).

async function main() {
  const config = loadConfig()
  const adminToken = config.adminToken || ensureAdminToken(config.dataDir)
  config.adminToken = adminToken
  const infra = createDockerDriver({ image: config.agentImage })
  const supabase = createCliSupabaseDriver({
    docker: infra.docker, cliPath: config.supabaseCli, rootDir: join(config.dataDir, 'supabase'),
    basePort: config.supabaseBasePort, log: { warn: (m) => console.warn(`[colony] ${m}`) },
  })
  const app = await createApp({
    config, infra, supabase,
    logger: { level: process.env.COLONY_LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers["x-colony-admin"]'] },
  })
  if (!config.oauthToken) console.warn('[colony] CLAUDE_CODE_OAUTH_TOKEN is not set (env or .env); agents cannot be spawned until it is.')
  const port = await app.start()
  console.log(`[colony] control plane on http://${config.bind}:${port} · data ${config.dataDir} · runners via ${config.publicRunnerUrl}`)
  // The one place the admin token is printed: the browser pairs by opening this link.
  console.log(`Open the Ops Deck: ${pairingLink(config.uiUrl, adminToken)}`)

  let closing = false
  const shutdown = async (sig: string) => {
    if (closing) return
    closing = true
    console.log(`[colony] ${sig}: shutting down (agent containers keep running)`)
    const force = setTimeout(() => process.exit(1), 10_000)
    force.unref()
    try {
      await app.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  watchLauncher(() => void shutdown('launcher exited'))
}

/** Started by `npm start` (scripts/start.mjs)? Then exit when the launcher is gone, so closing
 *  its window or killing it never leaves an orphaned control plane holding the port. */
function watchLauncher(onGone: () => void) {
  const pid = Number(process.env.COLONY_LAUNCHER_PID)
  if (!Number.isInteger(pid) || pid <= 0) return
  const t = setInterval(() => {
    try { process.kill(pid, 0) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') { clearInterval(t); onGone() }
    }
  }, 2000)
  t.unref()
}

main().catch((e) => {
  console.error('[colony] fatal:', e)
  process.exit(1)
})
