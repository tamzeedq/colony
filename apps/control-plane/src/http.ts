// REST routes (docs/phase1.md "Control plane"). Manual validation; errors are JSON:
//   { "error": { "code": "...", "message": "...", "details"?: ... } }

import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PROTOCOL_VERSION, ROLE_IDS, type Guards, type RoleId } from '@colony/shared'
import type { AgentManager } from './agents'
import type { Config } from './config'
import { badRequest, HttpError } from './errors'
import type { GuardService } from './guards'
import type { MergeService, ProjectService } from './projects'
import type { ProviderService, ProviderUpdate } from './providers'
import { isPriority, isQuestStatus, type QuestService } from './quests'
import type { Store } from './store'
import { assertRepoUrl } from './infra/validate'
import type { SupabaseService } from './supabase'

export interface HttpDeps {
  config: Config
  store: Store
  agents: AgentManager
  projects: ProjectService
  merges: MergeService
  guards: GuardService
  providers: ProviderService
  quests: QuestService
  supabase: SupabaseService
}

// ── validation helpers ────────────────────────────────────────────────────────

type Obj = Record<string, unknown>

function body(req: FastifyRequest): Obj {
  const b = req.body
  if (b === undefined || b === null || b === '') return {}
  if (typeof b !== 'object' || Array.isArray(b)) throw badRequest('body must be a JSON object')
  return b as Obj
}

function str(o: Obj, k: string, opts: { required: true; max?: number }): string
function str(o: Obj, k: string, opts?: { required?: false; max?: number }): string | undefined
function str(o: Obj, k: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const v = o[k]
  if (v === undefined || v === null) {
    if (opts.required) throw badRequest(`'${k}' is required`)
    return undefined
  }
  if (typeof v !== 'string') throw badRequest(`'${k}' must be a string`)
  const t = v.trim()
  if (opts.required && !t) throw badRequest(`'${k}' must not be empty`)
  if (opts.max && t.length > opts.max) throw badRequest(`'${k}' is longer than ${opts.max} characters`)
  return t
}

function num(o: Obj, k: string, opts: { min?: number; max?: number; int?: boolean } = {}): number | undefined {
  const v = o[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw badRequest(`'${k}' must be a number`)
  if (opts.int && !Number.isInteger(v)) throw badRequest(`'${k}' must be an integer`)
  if (opts.min !== undefined && v < opts.min) throw badRequest(`'${k}' must be ≥ ${opts.min}`)
  if (opts.max !== undefined && v > opts.max) throw badRequest(`'${k}' must be ≤ ${opts.max}`)
  return v
}

function strList(o: Obj, k: string): string[] | undefined {
  const v = o[k]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) throw badRequest(`'${k}' must be an array of strings`)
  return (v as string[]).map((s) => s.trim()).filter(Boolean)
}

const GUARD_PCT_KEYS = ['warnAtPct', 'pauseWorkersAtPct', 'orchestratorReservePct', 'weeklyWarnAtPct', 'autoDownshiftAtPct'] as const
const GUARD_BOOL_KEYS = ['paceForecast', 'resumeAfterReset'] as const

/** Validate a partial Guards patch: percentages 0–100, booleans, no unknown keys.
 *  `autoDownshiftAtPct: null` clears the optional threshold. */
export function parseGuardsPatch(b: Obj): Partial<Guards> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(b)) {
    if (!(GUARD_PCT_KEYS as readonly string[]).includes(k) && !(GUARD_BOOL_KEYS as readonly string[]).includes(k)) {
      throw badRequest(`unknown guard '${k}'`)
    }
  }
  for (const k of GUARD_PCT_KEYS) {
    if (!(k in b)) continue
    if (b[k] === null) {
      if (k !== 'autoDownshiftAtPct') throw badRequest(`'${k}' must be a number`)
      out[k] = undefined
      continue
    }
    out[k] = num(b, k, { min: 0, max: 100 })
  }
  for (const k of GUARD_BOOL_KEYS) {
    if (!(k in b)) continue
    if (typeof b[k] !== 'boolean') throw badRequest(`'${k}' must be a boolean`)
    out[k] = b[k]
  }
  return out as Partial<Guards>
}

const param = (req: FastifyRequest, k: string) => String((req.params as Obj)[k] ?? '')
const query = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string | undefined>
const truthy = (v: string | undefined) => v === '1' || v === 'true'

function bool(o: Obj, k: string): boolean | undefined {
  const v = o[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw badRequest(`'${k}' must be a boolean`)
  return v
}
const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._\/-]{1,200}$/

export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const h = new URL(origin).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
  } catch {
    return false
  }
}

export function checkAdmin(config: Config, headers: Record<string, string | string[] | undefined>, queryToken?: string): boolean {
  if (!config.adminToken) return true
  const auth = headers['authorization']
  const x = headers['x-colony-admin']
  const supplied = (typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined) ?? (typeof x === 'string' ? x : undefined) ?? queryToken
  if (typeof supplied !== 'string') return false
  const a = Buffer.from(supplied), b = Buffer.from(config.adminToken)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ── routes ────────────────────────────────────────────────────────────────────

export function registerRoutes(app: FastifyInstance, d: HttpDeps) {
  const { store, agents, projects, merges, config, guards, providers, quests, supabase } = d

  // Accept empty JSON bodies (e.g. POST /pause sent with a JSON content type).
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, raw, done) => {
    const text = String(raw)
    if (!text.trim()) return done(null, undefined)
    try { done(null, JSON.parse(text)) } catch { done(badRequest('invalid JSON body'), undefined) }
  })

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } })
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500
    if (status === 500) req.log.error({ err }, 'unhandled error')
    return reply.status(status).send({ error: { code: status === 500 ? 'internal' : (err.code ?? 'bad_request'), message: err.message } })
  })
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'not_found', message: `no route ${req.method} ${req.url}` } }))

  // Browsers: only local origins (CSRF). Optional admin token for everything but health.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLocalOrigin(req.headers.origin)) return reply.status(403).send({ error: { code: 'forbidden_origin', message: 'origin not allowed' } })
    if (req.url === '/api/health') return
    // Agents' MCP endpoint authenticates with the agent's own token (mcp.ts), never the admin token.
    if (req.url === '/mcp' || req.url.startsWith('/mcp?')) return
    if (!checkAdmin(config, req.headers)) return reply.status(401).send({ error: { code: 'unauthorized', message: 'admin token required' } })
  })

  app.get('/api/health', async () => ({
    ok: true, protocol: PROTOCOL_VERSION, docker: store.dockerUp ? 'running' : 'down',
    agents: store.agents.size, runnersConnected: store.connected.size, hasSubscriptionToken: !!config.oauthToken,
  }))

  app.get('/api/snapshot', async () => store.snapshot())

  // projects
  app.post('/api/projects', async (req, reply) => {
    const b = body(req)
    const repoUrl = str(b, 'repoUrl', { max: 500 })
    if (repoUrl) { try { assertRepoUrl(repoUrl) } catch (e) { throw badRequest((e as Error).message) } }
    const project = await projects.create({
      name: str(b, 'name', { required: true, max: 80 }),
      goal: str(b, 'goal', { max: 4000 }),
      stack: strList(b, 'stack'),
      repoUrl: repoUrl || undefined,
      dailyCapUsd: num(b, 'dailyCapUsd', { min: 0 }),
      supabase: bool(b, 'supabase'),
      supabaseStudio: bool(b, 'supabaseStudio'),
    })
    return reply.status(201).send(project)
  })
  app.patch('/api/projects/:id', async (req) => {
    const b = body(req)
    const goal = str(b, 'goal', { max: 4000 })
    const dailyCapUsd = num(b, 'dailyCapUsd', { min: 0 })
    if (goal === undefined && dailyCapUsd === undefined) throw badRequest("send 'goal' and/or 'dailyCapUsd'")
    const r = projects.patch(param(req, 'id'), { goal, dailyCapUsd })
    if (dailyCapUsd !== undefined) guards.checkProjectBudget(r.project.id)
    return r
  })
  app.delete('/api/projects/:id', async (req) => projects.remove(param(req, 'id'), { purge: truthy(query(req).purge) }))
  // dev Supabase (docs/phase4.md)
  app.get('/api/projects/:id/supabase', async (req) => supabase.details(param(req, 'id')))
  app.post('/api/projects/:id/supabase/:action', async (req, reply) => {
    const id = param(req, 'id')
    const action = param(req, 'action')
    projects.get(id)
    let info
    if (action === 'start') info = supabase.start(id)
    else if (action === 'stop') info = supabase.stop(id)
    else if (action === 'reset') info = supabase.reset(id, bool(body(req), 'confirm') === true)
    else throw badRequest("action must be 'start', 'stop' or 'reset'")
    return reply.status(202).send(info)
  })
  app.patch('/api/projects/:id/supabase', async (req) => {
    const b = body(req)
    for (const k of Object.keys(b)) if (k !== 'studio') throw badRequest(`unknown field '${k}'`)
    const studio = bool(b, 'studio')
    if (studio === undefined) throw badRequest("send 'studio'")
    projects.get(param(req, 'id'))
    return supabase.setStudio(param(req, 'id'), studio)
  })
  app.get('/api/projects/:id/branches', async (req) => projects.branches(param(req, 'id')))
  app.get('/api/projects/:id/diff', async (req, reply) => {
    const branch = query(req).branch
    if (!branch || !BRANCH_RE.test(branch)) throw badRequest("query 'branch' is required and must be a valid branch name")
    const diff = await projects.diff(param(req, 'id'), branch)
    return reply.type('text/plain; charset=utf-8').send(diff)
  })

  // agents
  app.post('/api/projects/:id/agents', async (req, reply) => {
    const b = body(req)
    const role = str(b, 'role', { required: true })
    if (!(ROLE_IDS as readonly string[]).includes(role)) throw badRequest(`'role' must be one of ${ROLE_IDS.join(', ')}`)
    const agent = await agents.spawn(param(req, 'id'), {
      role: role as RoleId,
      model: str(b, 'model', { max: 100 }),
      callsign: str(b, 'callsign', { max: 24 }),
      task: str(b, 'task', { max: 20_000 }),
      budgetCapUsd: num(b, 'budgetCapUsd', { min: 0 }),
      rolePrompt: str(b, 'rolePrompt', { max: 50_000 }),
    })
    return reply.status(201).send(agent)
  })
  app.post('/api/agents/:id/message', async (req) => {
    const text = str(body(req), 'text', { required: true, max: 50_000 })
    return agents.message(param(req, 'id'), text)
  })
  app.post('/api/agents/pause-all', async () => agents.pauseAll())
  app.post('/api/agents/:id/take-control', async (req) => agents.takeControl(param(req, 'id')))
  app.post('/api/agents/:id/hand-back', async (req) => {
    const note = str(body(req), 'note', { max: 10_000 })
    return agents.handBack(param(req, 'id'), note || undefined)
  })
  app.post('/api/agents/:id/pause', async (req) => agents.pause(param(req, 'id'), 'you'))
  app.post('/api/agents/:id/resume', async (req) => agents.resume(param(req, 'id')))
  app.post('/api/agents/:id/interrupt', async (req) => agents.interrupt(param(req, 'id')))
  app.post('/api/agents/:id/restart', async (req) => agents.restart(param(req, 'id')))
  app.delete('/api/agents/:id', async (req) => agents.kill(param(req, 'id'), { purge: truthy(query(req).purge) }))
  app.patch('/api/agents/:id', async (req) => {
    const b = body(req)
    const rolePrompt = b.rolePrompt === undefined ? undefined : str(b, 'rolePrompt', { required: true, max: 50_000 })
    return agents.patch(param(req, 'id'), {
      model: str(b, 'model', { max: 100 }),
      rolePrompt,
      budgetCapUsd: num(b, 'budgetCapUsd', { min: 0 }),
    })
  })
  app.get('/api/agents/:id/events', async (req) => {
    const id = param(req, 'id')
    agents.get(id)
    const raw = query(req).limit
    const limit = raw === undefined ? 100 : Number(raw)
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw badRequest("'limit' must be an integer 1–2000")
    return store.agentEvents(id, limit)
  })

  // merge requests
  app.post('/api/merge-requests', async (req, reply) => {
    const b = body(req)
    const branch = str(b, 'branch', { required: true, max: 200 })
    if (!BRANCH_RE.test(branch) || branch === 'main') throw badRequest("'branch' must be a valid non-main branch name")
    const mr = merges.create({
      projectId: str(b, 'projectId', { required: true }),
      branch,
      requestedBy: str(b, 'requestedBy'),
      prNumber: num(b, 'prNumber', { int: true, min: 1 }),
    })
    return reply.status(201).send(mr)
  })
  app.post('/api/merge-requests/:id/approve', async (req) => merges.approve(param(req, 'id')))
  app.post('/api/merge-requests/:id/request-changes', async (req) => {
    const note = str(body(req), 'note', { required: true, max: 20_000 })
    return merges.requestChanges(param(req, 'id'), note)
  })

  // quests (the commander's side; agents use the MCP tools)
  app.post('/api/projects/:id/quests', async (req, reply) => {
    const b = body(req)
    if (b.priority !== undefined && !isPriority(b.priority)) throw badRequest("'priority' must be low, normal or high")
    const acceptance = strList(b, 'acceptance')
    if (acceptance && acceptance.length > 20) throw badRequest("'acceptance' has more than 20 items")
    const q = quests.create(param(req, 'id'), {
      title: str(b, 'title', { required: true, max: 200 }),
      brief: str(b, 'brief', { max: 20_000 }),
      priority: b.priority as 'low' | 'normal' | 'high' | undefined,
      acceptance,
    }, 'you')
    return reply.status(201).send(q)
  })
  app.patch('/api/quests/:id', async (req) => {
    const b = body(req)
    for (const k of Object.keys(b)) if (!['status', 'title', 'brief', 'priority'].includes(k)) throw badRequest(`unknown field '${k}'`)
    if (b.status !== undefined && !isQuestStatus(b.status)) throw badRequest("'status' is not a quest status")
    if (b.priority !== undefined && !isPriority(b.priority)) throw badRequest("'priority' must be low, normal or high")
    return quests.patch(param(req, 'id'), {
      status: b.status as never,
      title: b.title === undefined ? undefined : str(b, 'title', { required: true, max: 200 }),
      brief: str(b, 'brief', { max: 20_000 }),
      priority: b.priority as 'low' | 'normal' | 'high' | undefined,
    }, 'you')
  })

  // guards
  app.get('/api/guards', async () => store.guards)
  app.patch('/api/guards', async (req) => {
    const next = store.setGuards(parseGuardsPatch(body(req)))
    guards.checkPlanUsage() // a lowered threshold applies right away
    return next
  })

  // providers (keys are write-only: responses carry hasKey / keyHint / status, never the key)
  app.get('/api/providers', async () => providers.list())
  app.put('/api/providers/:id', async (req) => {
    const id = providers.mustId(param(req, 'id'))
    const b = body(req)
    for (const k of Object.keys(b)) if (!['apiKey', 'baseUrl', 'models'].includes(k)) throw badRequest(`unknown field '${k}'`)
    const u: ProviderUpdate = {}
    if (b.apiKey !== undefined) {
      if (typeof b.apiKey !== 'string' || !b.apiKey.trim()) throw badRequest("'apiKey' must be a non-empty string (use DELETE /api/providers/:id/key to remove it)")
      const k = b.apiKey.trim()
      if (k.length > 1000 || /[\s\x00-\x1f\x7f]/.test(k)) throw badRequest("'apiKey' must be at most 1000 characters with no whitespace or control characters")
      u.apiKey = k
    }
    if (b.baseUrl !== undefined) {
      const url = str(b, 'baseUrl', { max: 500 }) ?? ''
      if (url) {
        let parsed: URL
        try { parsed = new URL(url) } catch { throw badRequest("'baseUrl' must be an http(s) URL") }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw badRequest("'baseUrl' must be an http(s) URL")
        if (parsed.username || parsed.password) throw badRequest("'baseUrl' must not contain credentials")
      }
      u.baseUrl = url
    }
    if (b.models !== undefined) {
      const models = strList(b, 'models') ?? []
      if (models.length > 100 || models.some((m) => m.length > 100)) throw badRequest("'models' must be at most 100 ids of at most 100 characters")
      u.models = [...new Set(models)]
    }
    const view = providers.update(id, u)
    store.broadcastSnapshot()
    return view
  })
  app.delete('/api/providers/:id/key', async (req) => {
    const view = providers.deleteKey(providers.mustId(param(req, 'id')))
    store.broadcastSnapshot()
    return view
  })
  app.post('/api/providers/:id/test', async (req) => {
    const view = await providers.test(providers.mustId(param(req, 'id')))
    store.broadcastSnapshot()
    return view
  })

  // alerts (addition: lets the UI dismiss/resolve an alert)
  app.post('/api/alerts/:id/resolve', async (req) => {
    const a = store.resolveAlert(param(req, 'id'))
    if (!a) throw new HttpError(404, 'not_found', 'alert not found')
    return a
  })
}
