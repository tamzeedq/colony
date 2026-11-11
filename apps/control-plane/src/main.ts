// Colony control plane entry point: `npm run dev -w @colony/control-plane`.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from './app'
import { loadConfig } from './config'
import { createDockerDriver } from './infra/docker'

/** Agent containers can reach the host port (even a loopback-only bind, via Docker Desktop),
 *  so the REST API and UI stream always require an admin token. It lives only on the host,
 *  in <dataDir>/admin-token, which no container can read. */
function ensureAdminToken(dataDir: string): string {
  const file = join(dataDir, 'admin-token')
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim()
    if (t.length >= 32) return t
  }
  mkdirSync(dataDir, { recursive: true })
  const t = randomBytes(32).toString('hex')
  writeFileSync(file, t + '\n', { mode: 0o600 })
  return t
}

function pairingLink(uiUrl: string, adminToken: string): string {
  return `${uiUrl.replace(/\/+$/, '')}/#pair=${encodeURIComponent(adminToken)}`
}

async function main() {
  const config = loadConfig()
  const adminToken = config.adminToken || ensureAdminToken(config.dataDir)
  config.adminToken = adminToken
  const infra = createDockerDriver({ image: config.agentImage })
  const app = await createApp({
    config, infra,
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
}

main().catch((e) => {
  console.error('[colony] fatal:', e)
  process.exit(1)
})
