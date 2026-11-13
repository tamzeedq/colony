// The admin token (docs/phase1.md "Control plane"): it lives only on the host in
// <dataDir>/admin-token, which no container can read, and is printed once, as the pairing
// link, to the control plane's stdout. Rotation (feedback item 6) writes a new one and prints
// the new link there; no HTTP response ever carries the token.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Config } from './config'

export const adminTokenFile = (dataDir: string) => join(dataDir, 'admin-token')

function writeToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true })
  const t = randomBytes(32).toString('hex')
  writeFileSync(adminTokenFile(dataDir), t + '\n', { mode: 0o600 })
  return t
}

export function ensureAdminToken(dataDir: string): string {
  const file = adminTokenFile(dataDir)
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim()
    if (t.length >= 32) return t
  }
  return writeToken(dataDir)
}

export function pairingLink(uiUrl: string, adminToken: string): string {
  return `${uiUrl.replace(/\/+$/, '')}/#pair=${encodeURIComponent(adminToken)}`
}

export interface RotateResult {
  ok: true
  pairingHint: string
  /** COLONY_ADMIN_TOKEN is set in the environment and would win again on the next start. */
  envOverride?: boolean
}

/** New token on disk and in memory; the pairing link goes to `print` (stdout) only. */
export function rotateAdminToken(config: Config, print: (line: string) => void = (l) => console.log(l), env: NodeJS.ProcessEnv = process.env): RotateResult {
  const token = writeToken(config.dataDir)
  config.adminToken = token
  print(`[colony] Admin token rotated. Open the Ops Deck: ${pairingLink(config.uiUrl, token)}`)
  const envOverride = !!env.COLONY_ADMIN_TOKEN
  return {
    ok: true,
    pairingHint: 'The old token no longer works. Re-pair this browser with the new pairing link printed in the control plane\'s terminal (the "npm start" window).',
    ...(envOverride ? { envOverride: true } : {}),
  }
}

export function registerAdminRoutes(app: FastifyInstance, d: { config: Config; print?: (line: string) => void }) {
  // Behind the admin-token hook (http.ts), like every other /api route.
  app.post('/api/admin/rotate-token', async () => rotateAdminToken(d.config, d.print))
}
