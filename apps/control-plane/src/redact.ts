// Secret redaction (feedback item 6). Every ActivityEvent is scrubbed here before it is stored
// or broadcast (Store.addEvent), so a key an agent echoes never reaches the feed, the event DB
// or the UI. Two layers:
//   1. known secret values: the bases' Supabase keys, the OAuth and admin tokens, the GitHub
//      token and provider API keys (agent tokens are only stored hashed, so they cannot leak);
//   2. secret-shaped strings (SECRET_PATTERNS in @colony/shared: JWTs, sk-ant-…, ghp_…,
//      sb_secret_…, AKIA…, private-key blocks, KEY=/SECRET=/TOKEN= assignments).
// Also the merge guard's diff scan (request_merge, merges, GitHub publish).

import { join } from 'node:path'
import { maskSecrets, PROVIDER_IDS, scanDiffForSecrets, type ActivityEvent, type DiffSecretFinding } from '@colony/shared'
import type { Config } from './config'
import type { Db } from './db'
import { SecretBox } from './providers'

export const MASK = '[redacted]'
const MIN_KNOWN = 8

/** Scrub known secret values and secret-shaped strings from text that may be shown, stored or logged. */
export function redactText(text: string, known: readonly (string | undefined)[] = []): string {
  let out = String(text ?? '')
  if (!out) return out
  for (const s of known) {
    if (!s || s.length < MIN_KNOWN || !out.includes(s.slice(0, MIN_KNOWN))) continue
    out = out.split(s).join(MASK)
  }
  // Private-key blocks span lines: mask the body too, up to the END line (or the end of the text).
  out = out.replace(/-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY(?: BLOCK)?-----|$)/g, `-----BEGIN $1PRIVATE KEY----- ${MASK}`)
  out = maskSecrets(out, MASK)
  return out
    .replace(/(authorization:\s*(?:basic|bearer|token)\s+)[^\s"']+/gi, `$1${MASK}`)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`)
}

/** The event with every free-text and payload field scrubbed (same object if nothing changed). */
export function redactEvent(ev: ActivityEvent, known: readonly (string | undefined)[] = []): ActivityEvent {
  const r = (s: string) => redactText(s, known)
  let changed = false
  const pick = <T extends string | undefined>(v: T): T => {
    if (typeof v !== 'string' || !v) return v
    const next = r(v)
    if (next !== v) changed = true
    return next as T
  }
  const out: ActivityEvent = { ...ev, text: pick(ev.text) }
  if (ev.command) out.command = { ...ev.command, cmd: pick(ev.command.cmd), ...(ev.command.outputTail !== undefined ? { outputTail: pick(ev.command.outputTail) } : {}) }
  if (ev.edit) out.edit = { ...ev.edit, path: pick(ev.edit.path), ...(ev.edit.hunk !== undefined ? { hunk: pick(ev.edit.hunk) } : {}) }
  if (ev.message) out.message = { ...ev.message, body: pick(ev.message.body) }
  if (ev.tool) out.tool = { ...ev.tool, ...(ev.tool.target !== undefined ? { target: pick(ev.tool.target) } : {}) }
  return changed ? out : ev
}

/** Known secret values, gathered from config and the kv store (cached briefly: one DB read per
 *  few seconds, not per event). */
export class SecretValues {
  private cache: { at: number; values: string[] } | undefined
  private box: SecretBox

  constructor(private db: Db, private config: Pick<Config, 'dataDir' | 'oauthToken' | 'adminToken'>, private ttlMs = 5_000, private now: () => number = Date.now) {
    this.box = new SecretBox(join(config.dataDir, 'master.key'))
  }

  invalidate() { this.cache = undefined }

  values(): string[] {
    const t = this.now()
    if (this.cache && t - this.cache.at < this.ttlMs) return this.cache.values
    const vals = new Set<string>()
    const add = (v: unknown) => { if (typeof v === 'string' && v.length >= MIN_KNOWN) vals.add(v) }
    add(this.config.oauthToken)
    add(this.config.adminToken)
    try {
      for (const r of this.db.all("SELECT value FROM kv WHERE key LIKE 'supabase_keys:%'")) {
        const k = JSON.parse(String(r.value)) as { anonKey?: string; serviceRoleKey?: string } | null
        add(k?.anonKey); add(k?.serviceRoleKey)
      }
    } catch { /* kv not readable: patterns still apply */ }
    const decrypt = (kvKey: string, field: 'token' | 'key', aad: string) => {
      try {
        const s = this.db.kvGet<Record<string, string>>(kvKey)
        if (s?.[field]) add(this.box.decrypt(s[field], aad))
      } catch { /* no key or undecryptable */ }
    }
    decrypt('github:token', 'token', 'github')
    for (const id of PROVIDER_IDS) decrypt(`provider:${id}`, 'key', id)
    const values = [...vals].sort((a, b) => b.length - a.length)
    this.cache = { at: t, values }
    return values
  }
}

// ── merge guard ──────────────────────────────────────────────────────────────

export interface SecretScan {
  ok: boolean
  files: DiffSecretFinding[]
  lines: DiffSecretFinding[]
}

/** kv key of the secret findings recorded when a flagged merge request was merged. */
export const secretScanKey = (mrId: string) => `secret_scan:${mrId}`

export function scanDiff(diff: string): SecretScan {
  const { files, lines } = scanDiffForSecrets(diff)
  return { ok: !files.length && !lines.length, files, lines }
}

/** A readable list of findings (values already masked), at most `max` lines. */
export function describeFindings(scan: Pick<SecretScan, 'files' | 'lines'>, max = 20): string {
  const out: string[] = []
  for (const f of scan.files) out.push(`- ${f.path}: ${f.kind}`)
  for (const l of scan.lines) out.push(`- ${l.path}:${l.line}: ${l.kind}${l.preview ? ` · ${redactText(l.preview)}` : ''}`)
  const extra = out.length - max
  return out.slice(0, max).join('\n') + (extra > 0 ? `\n- … and ${extra} more` : '')
}

export const SECRETS_ADVICE =
  'Remove them from the branch (and its history: amend or rebase the commits that added them), keep values in .env.local (git-ignored) ' +
  'or environment variables, and commit only placeholders such as .env.example. This applies to the local Supabase dev keys too.'
