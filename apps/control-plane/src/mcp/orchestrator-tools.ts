// Orchestrator-only MCP tools: plan quests, staff the team, review and request merges.
import { findModel, type Quest, type RoleId } from '@colony/shared'
import { describeFindings, scanDiff, SECRETS_ADVICE } from '../redact'
import { isPriority, isQuestStatus } from '../quests'
import { newId, nowIso } from '../store'
import {
  ToolError, WORKER_ROLES, acceptanceList, acceptanceSchema, agentView, clip, eventLine, list, n, obj, questView, s, str, strArr,
  type Tool, type ToolContext,
} from './helpers'

export function orchestratorTools(ctx: ToolContext): Tool[] {
  const { store, agents, quests, merges, infra, peer, slug } = ctx
  return [
    {
      name: 'create_task', roles: 'orchestrator',
      description: 'Create a quest: a small, verifiable unit of work for one worker. Returns the quest id.',
      inputSchema: obj({
        title: str, brief: { type: 'string', description: 'Structured Markdown, scannable in seconds: "Goal: <one line>", then short bullet sections "## What to build", "## Owns" (files/dirs), "## Constraints", "## Read first", "## Out of scope". No long paragraphs.' },
        acceptance: acceptanceSchema,
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        depends_on: { ...strArr, description: 'Quest ids that must be done (merged) first.' },
        why: { type: 'string', description: 'Your reasoning, e.g. why this model or ordering.' },
      }, ['title', 'brief', 'acceptance']),
      run: (a, me) => {
        const priority = a.priority === undefined ? undefined : isPriority(a.priority) ? a.priority : (() => { throw new ToolError("'priority' must be low, normal or high") })()
        const q = quests.create(me.agent.projectId, {
          title: s(a, 'title', true, 200), brief: s(a, 'brief', true), why: s(a, 'why', false, 4000),
          acceptance: acceptanceList(a, 'acceptance'), priority, dependsOn: list(a, 'depends_on'),
        }, me.agent.id)
        return questView(q, store)
      },
    },
    {
      name: 'update_task', roles: 'orchestrator',
      description: "Edit a quest. Status may be set to backlog, failed (cancel) or done (only for quests that need no merge, such as research).",
      inputSchema: obj({
        quest_id: str, title: str, brief: str, acceptance: acceptanceSchema, depends_on: strArr, why: str,
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        status: { type: 'string', enum: ['backlog', 'failed', 'done'] },
      }, ['quest_id']),
      run: (a, me) => {
        const status = a.status
        if (status !== undefined && !(isQuestStatus(status) && ['backlog', 'failed', 'done'].includes(status))) throw new ToolError("'status' must be backlog, failed or done")
        if (a.priority !== undefined && !isPriority(a.priority)) throw new ToolError("'priority' must be low, normal or high")
        const q = quests.patch(s(a, 'quest_id', true), {
          title: s(a, 'title', false, 200), brief: s(a, 'brief'), why: s(a, 'why', false, 4000),
          acceptance: acceptanceList(a, 'acceptance'), dependsOn: list(a, 'depends_on'),
          priority: a.priority as 'low' | 'normal' | 'high' | undefined, status: status as Quest['status'] | undefined,
        }, me, me.agent.projectId)
        return questView(q, store)
      },
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
        const scan = scanDiff(diff)
        if (!scan.ok) head.push(`WARNING: it adds secrets or secret files; request_merge will refuse it until they are gone:\n${describeFindings(scan)}\n${SECRETS_ADVICE}`)
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
        unverified_reason: { type: 'string', description: 'Only if agent-checkable criteria could not be verified: why. Shown to the commander.' },
      }, ['quest_id', 'summary']),
      run: async (a, me) => {
        const q = quests.inProject(s(a, 'quest_id', true), me.agent.projectId)
        // Feedback #11: agent-checkable criteria are verified by a QA agent before the commander sees the merge.
        const open = quests.unverified(q)
        const reason = s(a, 'unverified_reason', false, 1000)
        if (open.length && !reason) {
          throw new ToolError(`quest ${q.id} has ${open.length} agent-checkable criteria not verified as passing: ${open.map((o) => `${o.index}. ${o.text}${o.failed ? ' (FAILED)' : ''}`).join('; ')}. Use request_verification with a qa worker first (spawn one on haiku if needed). If they truly cannot be verified, pass unverified_reason.`)
        }
        const humanItems = q.acceptance.filter((x) => x.check === 'human' && !x.done).length
        const extra = [
          open.length ? `Unverified (${open.length}): ${reason}` : '',
          humanItems ? `Needs you: ${humanItems} criteria for the commander to check.` : '',
        ].filter(Boolean).join('\n')
        const branch = s(a, 'branch', false, 200) ?? q.branch
        if (!branch || branch === 'main') throw new ToolError('the quest has no branch yet; pass branch')
        const info = (await infra.listBranches(slug(me))).find((b) => b.name === branch)
        if (!info) throw new ToolError(`branch ${branch} is not on the git server`)
        if (info.aheadOfMain === 0) throw new ToolError(`branch ${branch} has nothing ahead of main`)
        // Secrets guard (feedback item 6): no .env / key files or secret-shaped lines reach main.
        const scan = scanDiff(await infra.diff(slug(me), branch))
        if (!scan.ok) {
          throw new ToolError(`Refused: ${branch} adds secrets or secret files, so it cannot be merged:\n${describeFindings(scan)}\n\n${SECRETS_ADVICE}\nAsk ${q.assigneeId ? store.agents.get(q.assigneeId)?.agent.callsign ?? 'the worker' : 'the worker'} to fix it, review again, then request the merge.`)
        }
        const existing = [...store.mergeRequests.values()].find((m) => m.projectId === me.agent.projectId && m.branch === branch && m.status === 'pending')
        if (existing) return { mergeRequest: existing, note: 'A merge request for this branch is already waiting for the commander.' }
        const summary = s(a, 'summary', true, 4000)!
        const mr = merges.create({ projectId: me.agent.projectId, branch, requestedBy: me.agent.id, questId: q.id, summary: extra ? `${summary}\n${extra}` : summary })
        return { mergeRequest: mr, note: 'The commander has been asked to approve. You will be told when it is merged or sent back.' }
      },
    },
    {
      name: 'request_verification', roles: 'orchestrator',
      description: "After a worker completes a quest, ask a QA worker (not the author) to verify its agent-checkable acceptance criteria on the branch. Spawn a qa worker on haiku first if none is free. You are told when verification finishes; request_merge requires it.",
      inputSchema: obj({ quest_id: str, agent_id: { type: 'string', description: 'The QA worker (id or callsign).' } }, ['quest_id', 'agent_id']),
      run: (a, me) => {
        const v = peer(s(a, 'agent_id', true)!, me)
        const r = quests.requestVerification(s(a, 'quest_id', true)!, v.agent.id, me.agent.projectId)
        return { quest: questView(r.quest, store), verifier: r.verifier, criteria: r.criteria }
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
  ]
}
