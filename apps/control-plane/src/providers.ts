// Model providers (docs/phase2.md "New backend endpoints"): API keys stored encrypted at rest,
// a connection test per provider, and the no-secrets ProviderConfig view for the UI.
//
// Keys are encrypted with AES-256-GCM under <dataDir>/master.key (32 random bytes, created on
// first use, host only; no container can read it). Ciphertext lives in kv as
// `provider:<id>`. A key is never returned, logged or put in an error message: responses
// carry only `hasKey`, a masked `keyHint` and the status. Using non-Claude providers at
// runtime (LiteLLM gateway) is a later phase.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BUILTIN_MODEL_IDS, PROVIDER_IDS,
  type ProviderConfig, type ProviderId, type ProviderKind, type ProviderStatus,
} from '@colony/shared'
import type { Config } from './config'
import { badRequest, notFound } from './errors'
import { nowIso, type Store } from './store'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** What the API returns for a provider: ProviderConfig plus display-only extras. */
export interface ProviderView extends ProviderConfig {
  /** Masked key, e.g. `sk-…a1b2`. Present when hasKey (not for the subscription). */
  keyHint?: string
  /** Short reason when status is 'error'. */
  statusDetail?: string
  testedAt?: string
}

interface StoredProvider {
  /** v1:<base64(iv | tag | ciphertext)> */
  key?: string
  keyHint?: string
  baseUrl?: string
  models?: string[]
  status?: ProviderStatus
  statusDetail?: string
  testedAt?: string
}

const META: Record<ProviderId, { label: string; kind: ProviderKind; models: readonly string[] }> = {
  'claude-subscription': { label: 'Claude subscription', kind: 'subscription', models: BUILTIN_MODEL_IDS },
  'anthropic-api': { label: 'Anthropic API', kind: 'anthropic', models: BUILTIN_MODEL_IDS },
  openai: { label: 'OpenAI', kind: 'gateway', models: [] },
  google: { label: 'Google Gemini', kind: 'gateway', models: [] },
  openrouter: { label: 'OpenRouter', kind: 'gateway', models: [] },
  custom: { label: 'Custom (OpenAI-compatible)', kind: 'gateway', models: [] },
}

const TEST_TIMEOUT_MS = 10_000

export function isProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id)
}

/** First 3 + '…' + last 4; short keys are fully masked. */
export function maskKey(key: string): string {
  return key.length >= 12 ? `${key.slice(0, 3)}…${key.slice(-4)}` : '…'
}

// ── encryption ───────────────────────────────────────────────────────────────

export class SecretBox {
  private key: Buffer | undefined
  constructor(private file: string) {}

  private load(create: boolean): Buffer | undefined {
    if (this.key) return this.key
    if (existsSync(this.file)) {
      const k = readFileSync(this.file)
      if (k.length !== 32) throw new Error(`${this.file} is not a 32-byte key`)
      return (this.key = k)
    }
    if (!create) return undefined
    mkdirSync(dirname(this.file), { recursive: true })
    const k = randomBytes(32)
    try {
      writeFileSync(this.file, k, { mode: 0o600, flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      return this.load(false) // created concurrently
    }
    return (this.key = k)
  }

  encrypt(plain: string, aad: string): string {
    const key = this.load(true)!
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    c.setAAD(Buffer.from(aad))
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
  }

  decrypt(blob: string, aad: string): string {
    if (!blob.startsWith('v1:')) throw new Error('unknown secret format')
    const key = this.load(false)
    if (!key) throw new Error('master.key is missing')
    const raw = Buffer.from(blob.slice(3), 'base64')
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    d.setAAD(Buffer.from(aad))
    d.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
  }
}

// ── service ──────────────────────────────────────────────────────────────────

export interface ProviderUpdate {
  apiKey?: string
  baseUrl?: string
  models?: string[]
}

export class ProviderService {
  private box: SecretBox
  private fetch: FetchLike

  constructor(private store: Store, private config: Config, fetchImpl?: FetchLike) {
    this.box = new SecretBox(join(config.dataDir, 'master.key'))
    this.fetch = fetchImpl ?? ((url, init) => fetch(url, init))
  }

  private kvKey(id: ProviderId) { return `provider:${id}` }
  private stored(id: ProviderId): StoredProvider { return this.store.db.kvGet<StoredProvider>(this.kvKey(id)) ?? {} }
  private save(id: ProviderId, s: StoredProvider) { this.store.db.kvSet(this.kvKey(id), s) }

  mustId(id: string): ProviderId {
    if (!isProviderId(id)) throw notFound('provider')
    return id
  }

  view(id: ProviderId): ProviderView {
    const meta = META[id]
    const s = this.stored(id)
    if (id === 'claude-subscription') {
      const has = !!this.config.oauthToken
      const status: ProviderStatus = !has ? 'missing_key' : s.status ?? 'untested'
      return {
        id, label: meta.label, kind: meta.kind, hasKey: has, models: [...meta.models], status,
        ...(has && s.statusDetail ? { statusDetail: s.statusDetail } : {}),
        ...(has && s.testedAt ? { testedAt: s.testedAt } : {}),
      }
    }
    const hasKey = !!s.key
    return {
      id, label: meta.label, kind: meta.kind, hasKey,
      ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}),
      models: s.models ?? [...meta.models],
      status: hasKey ? s.status ?? 'untested' : 'missing_key',
      ...(hasKey && s.keyHint ? { keyHint: s.keyHint } : {}),
      ...(hasKey && s.statusDetail ? { statusDetail: s.statusDetail } : {}),
      ...(hasKey && s.testedAt ? { testedAt: s.testedAt } : {}),
    }
  }

  list(): ProviderView[] {
    return PROVIDER_IDS.map((id) => this.view(id))
  }

  update(id: ProviderId, u: ProviderUpdate): ProviderView {
    if (id === 'claude-subscription') throw badRequest('claude-subscription is built in; set CLAUDE_CODE_OAUTH_TOKEN in .env instead')
    if (u.baseUrl !== undefined && id !== 'custom') throw badRequest("'baseUrl' can only be set for the custom provider")
    const s = this.stored(id)
    const next: StoredProvider = { ...s }
    if (u.apiKey !== undefined) {
      next.key = this.box.encrypt(u.apiKey, id)
      next.keyHint = maskKey(u.apiKey)
    }
    if (u.baseUrl !== undefined) next.baseUrl = u.baseUrl || undefined
    if (u.models !== undefined) next.models = u.models
    if (u.apiKey !== undefined || (u.baseUrl !== undefined && u.baseUrl !== s.baseUrl)) {
      next.status = 'untested'
      delete next.statusDetail
      delete next.testedAt
    }
    this.save(id, next)
    return this.view(id)
  }

  deleteKey(id: ProviderId): ProviderView {
    if (id === 'claude-subscription') throw badRequest('claude-subscription is built in; remove CLAUDE_CODE_OAUTH_TOKEN from .env instead')
    const { key: _k, keyHint: _h, status: _s, statusDetail: _d, testedAt: _t, ...rest } = this.stored(id)
    this.save(id, rest)
    return this.view(id)
  }

  /** Call the provider's model-list endpoint with the stored key. Never throws for an
   *  upstream failure: the outcome is the provider's status. */
  async test(id: ProviderId): Promise<ProviderView> {
    const s = this.stored(id)
    if (id === 'claude-subscription') {
      // There is no cheap OAuth check outside Claude Code itself; the runner's plan-usage
      // reports are the proof that the token works.
      if (!this.config.oauthToken) return this.view(id)
      const ok = this.store.usage.source === 'connected'
      this.save(id, {
        ...s, status: ok ? 'connected' : 'untested', testedAt: nowIso(),
        statusDetail: ok ? undefined : 'verified once an agent reports plan usage',
      })
      return this.view(id)
    }
    if (!s.key) return this.view(id)
    let key: string
    try {
      key = this.box.decrypt(s.key, id)
    } catch (e) {
      this.save(id, { ...s, status: 'error', statusDetail: `cannot decrypt the stored key (${(e as Error).message}); set it again`, testedAt: nowIso() })
      return this.view(id)
    }
    const result = await this.probe(id, key, s.baseUrl)
    this.save(id, { ...this.stored(id), status: result.ok ? 'connected' : 'error', statusDetail: result.ok ? undefined : result.reason, testedAt: nowIso() })
    return this.view(id)
  }

  private request(id: ProviderId, key: string, baseUrl?: string): { url: string; headers: Record<string, string> } | { error: string } {
    switch (id) {
      case 'anthropic-api':
        return { url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }
      case 'openai':
        return { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${key}` } }
      case 'openrouter':
        return { url: 'https://openrouter.ai/api/v1/models', headers: { authorization: `Bearer ${key}` } }
      case 'google':
        return { url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: { 'x-goog-api-key': key } }
      case 'custom':
        if (!baseUrl) return { error: 'no base URL set' }
        return { url: `${baseUrl.replace(/\/+$/, '')}/models`, headers: { authorization: `Bearer ${key}` } }
      default:
        return { error: 'not testable' }
    }
  }

  private async probe(id: ProviderId, key: string, baseUrl?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const req = this.request(id, key, baseUrl)
    if ('error' in req) return { ok: false, reason: req.error }
    const scrub = (t: string) => t.split(key).join('…').replace(/\s+/g, ' ').trim().slice(0, 160)
    try {
      const res = await this.fetch(req.url, {
        method: 'GET',
        headers: { accept: 'application/json', ...req.headers },
        // Never follow a redirect with the key attached.
        redirect: 'manual',
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      })
      if (res.status >= 200 && res.status < 300) {
        await res.body?.cancel().catch(() => {})
        return { ok: true }
      }
      let detail = ''
      try {
        const text = (await res.text()).slice(0, 4000)
        try {
          const j = JSON.parse(text) as { error?: { message?: unknown } | unknown; message?: unknown }
          const m = (j.error && typeof j.error === 'object' ? (j.error as { message?: unknown }).message : j.error) ?? j.message
          if (typeof m === 'string') detail = m
        } catch { /* not JSON */ }
      } catch { /* no body */ }
      if (res.status >= 300 && res.status < 400) return { ok: false, reason: `unexpected redirect (HTTP ${res.status})` }
      return { ok: false, reason: scrub(`HTTP ${res.status}${detail ? `: ${detail}` : res.statusText ? ` ${res.statusText}` : ''}`) }
    } catch (e) {
      const err = e as Error & { cause?: { message?: string; code?: string } }
      if (err.name === 'TimeoutError' || err.name === 'AbortError') return { ok: false, reason: `timed out after ${TEST_TIMEOUT_MS / 1000} s` }
      return { ok: false, reason: scrub(`network error: ${err.cause?.code ?? err.cause?.message ?? err.message}`) }
    }
  }
}
