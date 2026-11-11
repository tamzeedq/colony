// Colony MCP server (docs/phase3.md): Streamable HTTP, stateless, JSON responses only.
// Agents authenticate with their own runner token; the role decides the tool set, and every
// tool acts only inside the agent's own project. There is no merge tool for anyone.

import type { FastifyInstance } from 'fastify'
import { findModel, ROLE_IDS, type ActivityEvent, type Quest, type RoleId } from '@colony/shared'
import { sha256, type AgentManager } from './agents'
import { HttpError } from './errors'
import type { InfraDriver } from './infra/types'
import type { MergeService } from './projects'
import { isPriority, isQuestStatus, type QuestService } from './quests'
import { newId, nowIso, type AgentRecord, type Store } from './store'

export interface McpDeps {
  store: Store
  agents: AgentManager
  quests: QuestService
  merges: MergeService
  infra: InfraDriver
}

type Args = Record<string, unknown>
type Json = Record<string, unknown>

interface Tool {
  name: string
  description: string
  inputSchema: Json
  roles: 'orchestrator' | 'worker' | 'all'
  run(a: Args, me: AgentRecord): Promise<unknown> | unknown
}

export class ToolError extends Error {}

// ── argument helpers ──────────────────────────────────────────────────────────

function s(a: Args, k: string, req: true, max?: number): string
function s(a: Args, k: string, req?: false, max?: number): string | undefined
function s(a: Args, k: string, req = false, max = 20_000): string | undefined {
  const v = a[k]
  if (v === undefined || v === null || v === '') {
    if (req) throw new ToolError(`'${k}' is required`)
    return undefined
  }
  if (typeof v !== 'string') throw new ToolError(`'${k}' must be a string`)
  const t = v.trim()
  if (req && !t) throw new ToolError(`'${k}' must not be empty`)
  if (t.length > max) throw new ToolError(`'${k}' is longer than ${max} characters`)
  return t
}
function list(a: Args, k: string, max = 50): string[] | undefined {
  const v = a[k]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ToolError(`'${k}' must be an array of strings`)
  if (v.length > max) throw new ToolError(`'${k}' has more than ${max} items`)
  return (v as string[]).map((x) => x.trim()).filter(Boolean)
}
function n(a: Args, k: string, min = 0): number | undefined {
  const v = a[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new ToolError(`'${k}' must be a number ≥ ${min}`)
  return v
}

const str = { type: 'string' }
const strArr = { type: 'array', items: { type: 'string' } }
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}\n… (clipped, ${t.length - max} more characters)` : t)

// ── views ─────────────────────────────────────────────────────────────────────

function questView(q: Quest, store: Store) {
  return {
    id: q.id, title: q.title, status: q.status, priority: q.priority,
    assignee: q.assigneeId ? store.agents.get(q.assigneeId)?.agent.callsign ?? q.assigneeId : null,
    assigneeId: q.assigneeId ?? null, branch: q.branch ?? null, dependsOn: q.dependsOn,
    acceptance: q.acceptance.map((x, i) => `${i}. [${x.done ? 'x' : ' '}] ${x.text}`),
    brief: q.brief,
  }
}

function agentView(rec: AgentRecord, store: Store) {
  const a = store.toAgent(rec)
  return {
    id: a.id, callsign: a.callsign, role: a.role, model: a.model, status: a.status, controller: a.controller,
    currentQuest: a.currentTaskId ?? null, currentAction: a.currentAction ?? '', branch: a.branch ?? null,
    contextPct: a.contextPct, spendTodayUsd: Math.round(a.spendTodayUsd * 100) / 100, budgetCapUsd: a.budgetCapUsd,
    questsDone: a.questsDone, connected: store.connected.has(a.id),
  }
}

function eventLine(e: ActivityEvent): string {
  const t = e.at.slice(11, 19)
  const extra = e.command?.exitCode !== undefined ? ` (exit ${e.command.exitCode})` : ''
  return `${t} ${e.kind}: ${e.text.replace(/\s+/g, ' ').slice(0, 200)}${extra}`
}

// ── tools ─────────────────────────────────────────────────────────────────────

export function buildTools(d: McpDeps): Tool[] {
  const { store, agents, quests, merges, infra } = d
  const WORKER_ROLES = ROLE_IDS.filter((r) => r !== 'orchestrator')

  const peer = (id: string, me: AgentRecord): AgentRecord => {
    const rec = store.agents.get(id) ?? [...store.agents.values()].find((r) => r.agent.callsign.toLowerCase() === id.toLowerCase())
    if (!rec || rec.agent.projectId !== me.agent.projectId) throw new ToolError(`no agent '${id}' in this project (use list_agents)`)
    return rec
  }
  const slug = (me: AgentRecord) => store.projects.get(me.agent.projectId)!.slug

  const askHuman = (a: Args, me: AgentRecord) => {
    const question = s(a, 'question', true, 2000)
    const options = (list(a, 'options', 6) ?? []).map((o) => o.slice(0, 80))
    const alert = store.raiseAlert({
      kind: 'question', severity: 'needs_you', projectId: me.agent.projectId, agentId: me.agent.id,
      title: `${me.agent.callsign}: ${question}`, detail: s(a, 'detail', false, 4000),
      actions: [...options.map((o) => ({ id: `reply:${o}`, label: o })), { id: 'dismiss', label: 'Dismiss' }],
    })
    store.patchAgent(me.agent.id, { status: 'waiting' })
    return { ok: true, alertId: alert.id, note: 'The commander has been asked. Their answer will arrive as a message; keep working on anything it does not block.' }
  }

  const tools: Tool[] = [
    // ── orchestrator ──
    {
      name: 'create_task', roles: 'orchestrator',
      description: 'Create a quest: a small, verifiable unit of work for one worker. Returns the quest id.',
      inputSchema: obj({
        title: str, brief: { type: 'string', description: 'What and why, plus the files/directories the worker owns.' },
        acceptance: { ...strArr, description: 'Objectively checkable criteria.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        depends_on: { ...strArr, description: 'Quest ids that must be done (merged) first.' },
        why: { type: 'string', description: 'Your reasoning, e.g. why this model or ordering.' },
      }, ['title', 'brief', 'acceptance']),
      run: (a, me) => {
        const priority = a.priority === undefined ? undefined : isPriority(a.priority) ? a.priority : (() => { throw new ToolError("'priority' must be low, normal or high") })()
        const q = quests.create(me.agent.projectId, {
          title: s(a, 'title', true, 200), brief: s(a, 'brief', true), why: s(a, 'why', false, 4000),
          acceptance: list(a, 'acceptance', 20), priority, dependsOn: list(a, 'depends_on'),
        }, me.agent.id)
        return questView(q, store)
      },
    },
    {
      name: 'update_task', roles: 'orchestrator',
      description: "Edit a quest. Status may be set to backlog, failed (cancel) or done (only for quests that need no merge, such as research).",
      inputSchema: obj({
        quest_id: str, title: str, brief: str, acceptance: strArr, depends_on: strArr, why: str,
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        status: { type: 'string', enum: ['backlog', 'failed', 'done'] },
      }, ['quest_id']),
      run: (a, me) => {
        const status = a.status
        if (status !== undefined && !(isQuestStatus(status) && ['backlog', 'failed', 'done'].includes(status))) throw new ToolError("'status' must be backlog, failed or done")
        if (a.priority !== undefined && !isPriority(a.priority)) throw new ToolError("'priority' must be low, normal or high")
        const q = quests.patch(s(a, 'quest_id', true), {
          title: s(a, 'title', false, 200), brief: s(a, 'brief'), why: s(a, 'why', false, 4000),
          acceptance: list(a, 'acceptance', 20), dependsOn: list(a, 'depends_on'),
          priority: a.priority as 'low' | 'normal' | 'high' | undefined, status: status as Quest['status'] | undefined,
        }, me, me.agent.projectId)
        return questView(q, store)
      },
    },
    {
      name: 'list_tasks', roles: 'all',
      description: 'List the quests in this project, optionally filtered by status.',
      inputSchema: obj({ status: { type: 'string', enum: ['backlog', 'in_progress', 'in_review', 'done', 'failed', 'blocked'] } }),
      run: (a, me) => store.projectQuests(me.agent.projectId).filter((q) => !a.status || q.status === a.status).map((q) => questView(q, store)),
    },
    {
      name: 'spawn_agent', roles: 'orchestrator',
      description: 'Start a worker container. Every agent shares the commander\'s subscription, so keep the team small. With quest_id, the quest is assigned as it boots.',
      inputSchema: obj({
        role: { type: 'string', enum: WORKER_ROLES },
        model: { type: 'string', enum: ['haiku-5.5', 'sonnet-5.5', 'opus-5.5', 'fable-5.1'], description: 'Default sonnet-5.5.' },
        callsign: { type: 'string', description: 'Optional, like "Vex-07".' },
        quest_id: str,
        budget_cap_usd: { type: 'number' },
      }, ['role']),
      run: async (a, me) => {
        const role = s(a, 'role', true) as RoleId
        if (!WORKER_ROLES.includes(role as (typeof WORKER_ROLES)[number])) throw new ToolError(`'role' must be one of ${WORKER_ROLES.join(', ')}`)
        const model = s(a, 'model', false, 100)
        if (model && !findModel(model)) throw new ToolError(`unknown model '${model}'`)
        const questId = s(a, 'quest_id')
        if (questId) quests.inProject(questId, me.agent.projectId)
        const agent = await agents.spawn(me.agent.projectId, { role, model, callsign: s(a, 'callsign', false, 24), budgetCapUsd: n(a, 'budget_cap_usd') })
        const assigned = questId ? quests.assign(questId, agent.id, me.agent.projectId) : undefined
        return { agent: agentView(agents.get(agent.id), store), ...(assigned ? { quest: questView(assigned.quest, store), waitingOn: assigned.waitingOn } : {}) }
      },
    },
    {
      name: 'assign_task', roles: 'orchestrator',
      description: 'Give a quest to a worker. If its dependencies are not done yet it is held (blocked) and sent automatically once they are.',
      inputSchema: obj({ quest_id: str, agent_id: { type: 'string', description: 'Agent id or callsign.' } }, ['quest_id', 'agent_id']),
      run: (a, me) => {
        const target = peer(s(a, 'agent_id', true), me)
        const r = quests.assign(s(a, 'quest_id', true), target.agent.id, me.agent.projectId)
        return { quest: questView(r.quest, store), sent: r.sent, waitingOn: r.waitingOn }
      },
    },
    {
      name: 'message_agent', roles: 'orchestrator',
      description: 'Send a message to an agent in this project, delivered mid-run.',
      inputSchema: obj({ agent_id: { type: 'string', description: 'Agent id or callsign.' }, text: str }, ['agent_id', 'text']),
      run: (a, me) => {
        const target = peer(s(a, 'agent_id', true), me)
        if (target.agent.id === me.agent.id) throw new ToolError('that is you')
        const text = s(a, 'text', true)
        agents.deliver(target.agent.id, `[From ${me.agent.callsign} (orchestrator)] ${text}`)
        store.addEvent({
          id: newId('ev'), at: nowIso(), agentId: me.agent.id, projectId: me.agent.projectId, kind: 'message',
          text: `${me.agent.callsign} → ${target.agent.callsign}: ${text}`, message: { to: target.agent.id, body: text },
        })
        return { ok: true, delivered: store.connected.has(target.agent.id) }
      },
    },
    {
      name: 'list_agents', roles: 'orchestrator',
      description: 'Who is on the team: role, model, status, current quest and action, spend.',
      inputSchema: obj({}),
      run: (_a, me) => store.projectAgents(me.agent.projectId).map((r) => agentView(r, store)),
    },
    {
      name: 'get_agent_status', roles: 'orchestrator',
      description: "One agent's status, its current quest and its last 15 activity events.",
      inputSchema: obj({ agent_id: str }, ['agent_id']),
      run: (a, me) => {
        const target = peer(s(a, 'agent_id', true), me)
        const q = target.agent.currentTaskId ? store.quests.get(target.agent.currentTaskId) : undefined
        return {
          ...agentView(target, store),
          quest: q ? questView(q, store) : null,
          recent: store.agentEvents(target.agent.id, 15).map(eventLine),
        }
      },
    },
    {
      name: 'review_branch', roles: 'orchestrator',
      description: 'Inspect a branch against main: commits ahead/behind and the diff. To run its tests, check it out in your own workspace (instructions included).',
      inputSchema: obj({ branch: str, agent_id: str, quest_id: str }),
      run: async (a, me) => {
        let branch = s(a, 'branch', false, 200)
        if (!branch && a.quest_id) branch = quests.inProject(s(a, 'quest_id', true), me.agent.projectId).branch
        if (!branch && a.agent_id) branch = peer(s(a, 'agent_id', true), me).agent.branch
        if (!branch) throw new ToolError('pass branch, agent_id or quest_id')
        if (branch === 'main') throw new ToolError('pick a branch other than main')
        const info = (await infra.listBranches(slug(me))).find((b) => b.name === branch)
        if (!info) throw new ToolError(`branch ${branch} is not on the git server (has the worker pushed?)`)
        const diff = await infra.diff(slug(me), branch)
        const head = [`Branch ${branch}: ${info.aheadOfMain} commit(s) ahead of main, ${info.behindMain} behind (head ${info.sha.slice(0, 10)}).`]
        if (info.behindMain > 0) head.push('It is behind main: ask the worker to rebase before you request the merge.')
        head.push(`To test it: git fetch origin && git stash -u; git checkout --detach origin/${branch} (then go back with git checkout -).`)
        return `${head.join('\n')}\n\n${clip(diff || '(no differences)', 60_000)}`
      },
    },
    {
      name: 'request_merge', roles: 'orchestrator',
      description: 'Ask the commander to approve merging a reviewed branch into main. You cannot merge yourself.',
      inputSchema: obj({
        quest_id: str,
        summary: { type: 'string', description: 'A few lines: what it does, which quest it closes, how you verified it, anything risky.' },
        branch: { type: 'string', description: "Defaults to the quest's branch." },
      }, ['quest_id', 'summary']),
      run: async (a, me) => {
        const q = quests.inProject(s(a, 'quest_id', true), me.agent.projectId)
        const branch = s(a, 'branch', false, 200) ?? q.branch
        if (!branch || branch === 'main') throw new ToolError('the quest has no branch yet; pass branch')
        const info = (await infra.listBranches(slug(me))).find((b) => b.name === branch)
        if (!info) throw new ToolError(`branch ${branch} is not on the git server`)
        if (info.aheadOfMain === 0) throw new ToolError(`branch ${branch} has nothing ahead of main`)
        const existing = [...store.mergeRequests.values()].find((m) => m.projectId === me.agent.projectId && m.branch === branch && m.status === 'pending')
        if (existing) return { mergeRequest: existing, note: 'A merge request for this branch is already waiting for the commander.' }
        const mr = merges.create({ projectId: me.agent.projectId, branch, requestedBy: me.agent.id, questId: q.id, summary: s(a, 'summary', true, 4000) })
        return { mergeRequest: mr, note: 'The commander has been asked to approve. You will be told when it is merged or sent back.' }
      },
    },
    {
      name: 'stop_agent', roles: 'orchestrator',
      description: "Shut a worker down. Its branch stays on the git server; its unfinished quests go back to the backlog.",
      inputSchema: obj({ agent_id: str }, ['agent_id']),
      run: async (a, me) => {
        const target = peer(s(a, 'agent_id', true), me)
        if (target.agent.id === me.agent.id) throw new ToolError('you cannot stop yourself')
        await agents.kill(target.agent.id)
        return { ok: true, stopped: target.agent.callsign }
      },
    },
    { name: 'request_human', roles: 'all',
      description: "Ask the commander a question that only they can decide. One decision per request; give options and your recommendation.",
      inputSchema: obj({ question: str, options: { ...strArr, description: 'Up to 6 short answers, shown as buttons.' }, detail: str }, ['question']),
      run: askHuman },

    // ── worker ──
    {
      name: 'report_progress', roles: 'worker',
      description: 'Post a short status update at a meaningful milestone, optionally ticking acceptance criteria by index.',
      inputSchema: obj({ text: str, quest_id: str, acceptance_done: { type: 'array', items: { type: 'integer' } } }, ['text']),
      run: (a, me) => {
        const done = a.acceptance_done
        if (done !== undefined && (!Array.isArray(done) || done.some((x) => !Number.isInteger(x)))) throw new ToolError("'acceptance_done' must be an array of integers")
        const q = quests.progress(me, s(a, 'text', true, 1000), s(a, 'quest_id'), done as number[] | undefined)
        return { ok: true, ...(q ? { quest: questView(q, store) } : {}) }
      },
    },
    {
      name: 'complete_task', roles: 'worker',
      description: 'Hand a finished quest back for review. Push your branch first.',
      inputSchema: obj({ quest_id: str, summary: { type: 'string', description: 'What changed, how you verified it, anything the reviewer should know.' } }, ['quest_id', 'summary']),
      run: async (a, me) => {
        const q = await quests.complete(s(a, 'quest_id', true), me, s(a, 'summary', true, 8000))
        return { ok: true, quest: questView(q, store), note: 'Handed to the orchestrator for review. Wait for feedback or a new quest; do not start unassigned work.' }
      },
    },
    {
      name: 'ask_orchestrator', roles: 'worker',
      description: 'Ask the orchestrator a question (unclear brief, files outside your area, a dependency on someone else).',
      inputSchema: obj({ text: str }, ['text']),
      run: (a, me) => {
        const text = s(a, 'text', true, 8000)
        const orch = quests.orchestratorOf(me.agent.projectId)
        if (!orch) return askHuman({ question: text.slice(0, 2000) }, me)
        agents.deliver(orch.agent.id, `[${me.agent.callsign} asks] ${text}\n(Answer with message_agent to ${me.agent.callsign}.)`)
        store.addEvent({
          id: newId('ev'), at: nowIso(), agentId: me.agent.id, projectId: me.agent.projectId, kind: 'message',
          text: `${me.agent.callsign} → ${orch.agent.callsign}: ${text}`, message: { to: orch.agent.id, body: text },
        })
        return { ok: true, note: `Sent to ${orch.agent.callsign}. The answer will arrive as a message.` }
      },
    },
  ]
  return tools
}

export function toolsFor(tools: Tool[], role: RoleId): Tool[] {
  const kind = role === 'orchestrator' ? 'orchestrator' : 'worker'
  return tools.filter((t) => t.roles === 'all' || t.roles === kind)
}

// ── JSON-RPC over HTTP ────────────────────────────────────────────────────────

interface RpcRequest { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown }

const rpcError = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

export async function handleRpc(msg: RpcRequest, me: AgentRecord, tools: Tool[]): Promise<object | undefined> {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'invalid request')
  const isNotification = msg.id === undefined || msg.id === null
  if (isNotification) return undefined
  const id = msg.id
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Json
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'colony', version: '0.3.0' },
          instructions: `Colony team tools for ${me.agent.callsign} (${me.agent.role}).`,
        },
      }
    case 'ping': return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list': {
      const mine = toolsFor(tools, me.agent.role)
      return { jsonrpc: '2.0', id, result: { tools: mine.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } }
    }
    case 'tools/call': {
      const name = params.name
      const tool = toolsFor(tools, me.agent.role).find((t) => t.name === name)
      if (!tool) return rpcError(id, -32602, `unknown tool '${String(name)}'`)
      const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Args
      try {
        const out = await tool.run(args, me)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] } }
      } catch (e) {
        const message = e instanceof ToolError || e instanceof HttpError ? e.message : `internal error: ${(e as Error).message}`
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } }
      }
    }
    default: return rpcError(id, -32601, `method not found: ${msg.method}`)
  }
}

export function registerMcp(app: FastifyInstance, d: McpDeps) {
  const tools = buildTools(d)
  const auth = (h: string | undefined): AgentRecord | undefined =>
    typeof h === 'string' && h.startsWith('Bearer ') ? d.store.agentByTokenHash(sha256(h.slice(7))) : undefined

  app.post('/mcp', async (req, reply) => {
    const me = auth(req.headers.authorization)
    if (!me) return reply.status(401).send(rpcError(null, -32001, 'unauthorized'))
    const body = req.body as RpcRequest | RpcRequest[] | undefined
    if (body === undefined) return reply.status(400).send(rpcError(null, -32700, 'parse error'))
    const batch = Array.isArray(body)
    const out = (await Promise.all((batch ? body : [body]).map((m) => handleRpc(m, me, tools)))).filter((r) => r !== undefined)
    if (!out.length) return reply.status(202).send()
    return reply.type('application/json').send(batch ? out : out[0])
  })
  const notAllowed = async (_req: unknown, reply: { status(n: number): { header(k: string, v: string): { send(b: unknown): unknown } } }) =>
    reply.status(405).header('allow', 'POST').send({ error: { code: 'method_not_allowed', message: 'Colony MCP is stateless; use POST' } })
  app.get('/mcp', notAllowed)
  app.delete('/mcp', notAllowed)
}
