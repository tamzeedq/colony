// REST routes (docs/phase1.md "Control plane"). Manual validation; errors are JSON:
//   { "error": { "code": "...", "message": "...", "details"?: ... } }

import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PROTOCOL_VERSION, ROLE_IDS, type RoleId } from '@colony/shared'
import type { AgentManager } from './agents'
import type { Config } from './config'
import { badRequest, HttpError } from './errors'
import type { MergeService, ProjectService } from './projects'
import type { Store } from './store'
import { assertRepoUrl } from './infra/validate'

export interface HttpDeps {
  config: Config
  store: Store
  agents: AgentManager
  projects: ProjectService
  merges: MergeService
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

const param = (req: FastifyRequest, k: string) => String((req.params as Obj)[k] ?? '')
const query = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string | undefined>
const truthy = (v: string | undefined) => v === '1' || v === 'true'
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
  const { store, agents, projects, merges, config } = d

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
    })
    return reply.status(201).send(project)
  })
  app.delete('/api/projects/:id', async (req) => projects.remove(param(req, 'id'), { purge: truthy(query(req).purge) }))
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

  // alerts (addition: lets the UI dismiss/resolve an alert)
  app.post('/api/alerts/:id/resolve', async (req) => {
    const a = store.resolveAlert(param(req, 'id'))
    if (!a) throw new HttpError(404, 'not_found', 'alert not found')
    return a
  })
}
