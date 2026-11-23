// Colony MCP server (docs/phase3.md): Streamable HTTP, stateless, JSON responses only.
// Agents authenticate with their own runner token; the role decides the tool set, and every
// tool acts only inside the agent's own project. There is no merge tool for anyone.
// Tool definitions live per role in mcp/orchestrator-tools.ts, mcp/worker-tools.ts and
// mcp/shared-tools.ts (helpers and the shared tool context in mcp/helpers.ts); this file
// composes them and speaks JSON-RPC over HTTP.

import type { FastifyInstance } from 'fastify'
import type { RoleId } from '@colony/shared'
import { sha256 } from './agents'
import { HttpError } from './errors'
import type { AgentRecord } from './store'
import { ToolError, toolContext, type Args, type Json, type McpDeps, type Tool } from './mcp/helpers'
import { orchestratorTools } from './mcp/orchestrator-tools'
import { sharedTools } from './mcp/shared-tools'
import { workerTools } from './mcp/worker-tools'

export { ToolError }
export type { McpDeps }

export function buildTools(d: McpDeps): Tool[] {
  const ctx = toolContext(d)
  return [...orchestratorTools(ctx), ...sharedTools(ctx), ...workerTools(ctx)]
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
