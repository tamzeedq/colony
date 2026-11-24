// MCP tools every role gets: quest listing, dev backend, verification, asking the commander.
import { ToolError, obj, questView, s, str, strArr, type Tool, type ToolContext } from './helpers'

export function sharedTools(ctx: ToolContext): Tool[] {
  const { store, quests, supabase, askHuman } = ctx
  return [
    {
      name: 'list_tasks', roles: 'all',
      description: 'List the quests in this project, optionally filtered by status. Archived (old finished) quests are left out unless include_archived is true.',
      inputSchema: obj({ status: { type: 'string', enum: ['backlog', 'in_progress', 'in_review', 'done', 'failed', 'blocked'] }, include_archived: { type: 'boolean' } }),
      run: (a, me) => store.projectQuests(me.agent.projectId)
        .filter((q) => (!a.status || q.status === a.status) && (a.include_archived === true || !q.archivedAt))
        .map((q) => questView(q, store)),
    },
    {
      name: 'get_backend', roles: 'all',
      description: 'Status of the dev Supabase of this base and the values agents use to reach it (SUPABASE_URL, keys, DATABASE_URL). Use it if those env vars are missing in your container.',
      inputSchema: obj({}),
      run: (_a, me) => {
        if (!supabase) return { status: 'none', env: null }
        return supabase.backendFor(me.agent.projectId, me.agent.role)
      },
    },
    {
      name: 'list_migrations', roles: 'all',
      description: 'Migrations applied to the dev Supabase of this base (version, name), oldest first.',
      inputSchema: obj({}),
      run: async (_a, me) => {
        if (!supabase) throw new ToolError('this base has no dev Supabase')
        return { migrations: await supabase.migrations(me.agent.projectId) }
      },
    },
    {
      name: 'gen_types', roles: 'all',
      description: 'Generate TypeScript types for the dev Supabase schema (supabase gen types typescript). Returns the file contents; save it where the project keeps its types.',
      inputSchema: obj({}),
      run: async (_a, me) => {
        if (!supabase) throw new ToolError('this base has no dev Supabase')
        const ts = await supabase.genTypes(me.agent.projectId)
        const max = 200 * 1024
        return ts.length > max ? `${ts.slice(0, max)}\n// … clipped at 200 KB` : ts
      },
    },
    {
      name: 'verify_acceptance', roles: 'all',
      description: 'Record the result of verifying one acceptance criterion of a quest you were asked to verify: result "pass" or "fail", with short evidence (the command you ran and what it showed).',
      inputSchema: obj({
        quest_id: str, index: { type: 'integer', description: 'Criterion index (0-based).' },
        result: { type: 'string', enum: ['pass', 'fail'] }, evidence: str,
      }, ['quest_id', 'index', 'result', 'evidence']),
      run: (a, me) => {
        const index = a.index
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new ToolError("'index' must be a non-negative integer")
        const result = a.result
        if (result !== 'pass' && result !== 'fail') throw new ToolError("'result' must be pass or fail")
        const q = quests.verify(s(a, 'quest_id', true)!, index, result, s(a, 'evidence', true, 2000)!, me)
        return questView(q, store)
      },
    },
    { name: 'request_human', roles: 'all',
      description: "Ask the commander a question that only they can decide. One decision per request; give options and your recommendation.",
      inputSchema: obj({ question: str, options: { ...strArr, description: 'Up to 6 short answers, shown as buttons.' }, detail: str }, ['question']),
      run: askHuman },
  ]
}
