// Worker-only MCP tools: report progress, hand a quest back, ask the orchestrator.
import { newId, nowIso } from '../store'
import { ToolError, obj, questView, s, str, type Tool, type ToolContext } from './helpers'

export function workerTools(ctx: ToolContext): Tool[] {
  const { store, agents, quests, askHuman } = ctx
  return [
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
}
