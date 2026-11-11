// Seed data matching the design canvas. Replace with your API.
import type { Agent, Alert, ActivityEvent, Guards, MergeRequest, Project, ProviderView, Quest, Resources, RoleId, ModelId, AgentStatus } from '@/types/colony'
import { BUILTIN_MODEL_IDS } from '@/types/colony'

const now = Date.now()
const iso = (offsetSec: number) => new Date(now + offsetSec * 1000).toISOString()

export const projects: Project[] = [
  { id: 'p-readable', key: 1, name: 'Readable', repoUrl: 'https://github.com/you/readable', stack: ['Next.js', 'Supabase', 'Tailwind'],
    goal: 'Ship reading streaks with daily reminder emails by Friday. Keep the JS bundle under 200 kB.',
    health: { score: 9, label: 'stable' }, supabase: { status: 'running', url: 'http://localhost:54321', studioUrl: 'http://localhost:54323', migration: '0041' },
    orchestratorId: 'atlas-01', agentIds: ['atlas-01', 'vex-07', 'mira-12', 'kip-03', 'rho-09', 'juno-22'],
    spendTodayUsd: 14.2, dailyCapUsd: 20, sessionShare: 0.24, unreadAlerts: 1 },
  { id: 'p-moneo', key: 2, name: 'Moneo', repoUrl: 'https://github.com/you/moneo', stack: ['React Native', 'Supabase', 'Plaid'],
    goal: 'Make bank sync reliable: retries, backoff and a clear error screen.',
    health: { score: 5, label: 'strained' }, supabase: { status: 'running', url: 'http://localhost:54421' },
    orchestratorId: 'sable-02', agentIds: ['sable-02', 'tern-14', 'lux-05', 'pike-18'],
    spendTodayUsd: 10.25, dailyCapUsd: 12, sessionShare: 0.17, unreadAlerts: 2 },
  { id: 'p-fit', key: 3, name: 'FitChecked', repoUrl: 'https://github.com/you/fitchecked', stack: ['SvelteKit', 'FastAPI', 'pgvector'],
    goal: 'Closet MVP: upload photos, tag items, suggest similar outfits.',
    health: { score: 8, label: 'stable' }, supabase: { status: 'running', url: 'http://localhost:54521' },
    orchestratorId: 'onyx-04', agentIds: ['onyx-04', 'wren-11', 'ash-06', 'dot-21'],
    spendTodayUsd: 13.95, dailyCapUsd: 20, sessionShare: 0.21, unreadAlerts: 1 },
  { id: 'p-tide', key: 4, name: 'Tidewater', repoUrl: 'https://github.com/you/tidewater', stack: ['Rust CLI'],
    goal: 'Tide table CLI with offline data packs.',
    health: { score: 0, label: 'dormant' }, supabase: { status: 'none' },
    orchestratorId: 'bram-16', agentIds: ['bram-16', 'quill-08'],
    spendTodayUsd: 0, dailyCapUsd: 5, sessionShare: 0, unreadAlerts: 0 },
]

const ROLE_PROMPT: Record<RoleId, string> = {
  orchestrator: 'You lead {project}. Break the goal into quests, hand them to workers, review before merge.',
  backend: 'You are the Backend engineer for {project}. Own API routes, SQL migrations and RLS. Write tests first. Never push to main.',
  frontend: 'You are the Frontend engineer for {project}. Own UI, components and accessibility. Keep bundles small.',
  qa: 'You are QA for {project}. Run suites, write E2E specs and gate PRs before merge.',
  devops: 'You are DevOps for {project}. Containers, CI, preview deploys, env wiring.',
  researcher: 'You research for {project}. Read docs and code, compare options, write short briefs.',
  custom: 'Custom role.',
}

function A(id: string, projectId: string, role: RoleId, model: ModelId, status: AgentStatus, extra: Partial<Agent>): Agent {
  const [name, num] = id.split('-')
  return {
    id, projectId, callsign: name[0].toUpperCase() + name.slice(1) + '-' + num, role, provider: 'claude-subscription', model, status, controller: 'agent',
    container: { name: `${projectId.slice(2)}-${id}`, cpuPct: 10, memMb: 900, memLimitMb: 4096, health: 'ok' },
    contextPct: 30, tokensToday: 200_000, spendTodayUsd: 1, budgetCapUsd: 10, sessionShare: 0.02, uptimeSec: 5400,
    level: 3, xp: 40, questsDone: 8, rolePrompt: ROLE_PROMPT[role], allowedTools: ['read', 'edit', 'bash'],
    ...extra,
  }
}

export const agents: Agent[] = [
  A('atlas-01', 'p-readable', 'orchestrator', 'opus-5.5', 'thinking', { currentAction: 'Splitting "Weekly recap email" into quests', branch: 'main', contextPct: 38, spendTodayUsd: 4.7, sessionShare: 0.04, level: 9, xp: 20, questsDone: 64 }),
  A('vex-07', 'p-readable', 'backend', 'sonnet-5.5', 'running', { currentTaskId: 'q-api', currentAction: 'npm test -- streaks', branch: 'feat/streaks-api', contextPct: 62, tokensToday: 1_240_000, spendTodayUsd: 6.82, sessionShare: 0.11, level: 7, xp: 35, questsDone: 26, uptimeSec: 8040, container: { name: 'readable-vex-07', cpuPct: 38, memMb: 1200, memLimitMb: 4096, health: 'ok' }, allowedTools: ['read', 'edit', 'bash', 'supabase'] }),
  A('mira-12', 'p-readable', 'frontend', 'sonnet-5.5', 'editing', { currentTaskId: 'q-mail', currentAction: 'emails/StreakReminder.tsx', branch: 'feat/streak-email', contextPct: 28, spendTodayUsd: 3.95, sessionShare: 0.05, level: 6, xp: 80, questsDone: 21 }),
  A('kip-03', 'p-readable', 'qa', 'haiku-5.5', 'waiting', { currentTaskId: 'q-ui', currentAction: 'Approve merge of PR #48?', branch: 'feat/reading-streaks', contextPct: 44, spendTodayUsd: 1.12, sessionShare: 0.02, level: 5, xp: 70, questsDone: 18 }),
  A('rho-09', 'p-readable', 'devops', 'sonnet-5.5', 'blocked', { currentTaskId: 'q-prev', currentAction: 'Waiting on migration 0042', branch: 'infra/preview-deploys', contextPct: 17, spendTodayUsd: 0.71, sessionShare: 0.01, level: 3, xp: 15, questsDone: 8 }),
  A('juno-22', 'p-readable', 'researcher', 'haiku-5.5', 'thinking', { currentAction: 'epub.js vs foliate-js', contextPct: 71, spendTodayUsd: 0.4, sessionShare: 0.01, level: 4, xp: 50, questsDone: 11 }),
  A('sable-02', 'p-moneo', 'orchestrator', 'opus-5.5', 'running', { currentAction: 'Reassigning "Plaid sync retry"', branch: 'main', contextPct: 47, spendTodayUsd: 3.8, sessionShare: 0.05, level: 8, xp: 45, questsDone: 51 }),
  A('tern-14', 'p-moneo', 'backend', 'sonnet-5.5', 'error', { currentTaskId: 'q-plaid', currentAction: 'Crashed: OOM (exit 137)', branch: 'fix/plaid-sync-retry', contextPct: 91, spendTodayUsd: 3.1, sessionShare: 0.05, level: 4, xp: 40, questsDone: 11, container: { name: 'moneo-tern-14', cpuPct: 0, memMb: 4096, memLimitMb: 4096, health: 'down' } }),
  A('lux-05', 'p-moneo', 'frontend', 'sonnet-5.5', 'editing', { currentTaskId: 'q-budget', currentAction: 'src/screens/Budget.tsx', branch: 'feat/budget-v2', contextPct: 52, spendTodayUsd: 2.65, sessionShare: 0.04, level: 4, xp: 25, questsDone: 10 }),
  A('pike-18', 'p-moneo', 'qa', 'haiku-5.5', 'idle', { contextPct: 8, spendTodayUsd: 0.3, sessionShare: 0.01, level: 2, xp: 60, questsDone: 5 }),
  A('onyx-04', 'p-fit', 'orchestrator', 'fable-5.1', 'thinking', { currentAction: 'Sprint plan v3 for the closet MVP', branch: 'main', contextPct: 22, spendTodayUsd: 5.1, sessionShare: 0.06, level: 6, xp: 65, questsDone: 33 }),
  A('wren-11', 'p-fit', 'backend', 'opus-5.5', 'thinking', { currentTaskId: 'q-similar', currentAction: 'HNSW vs IVFFlat for outfit search', branch: 'feat/similar-outfits', contextPct: 66, spendTodayUsd: 7.3, sessionShare: 0.09, level: 5, xp: 60, questsDone: 12 }),
  A('ash-06', 'p-fit', 'frontend', 'sonnet-5.5', 'waiting', { currentTaskId: 'q-photo', currentAction: 'Asked: Cloudinary or Supabase Storage?', branch: 'feat/photo-upload', contextPct: 53, spendTodayUsd: 2.4, sessionShare: 0.04, level: 3, xp: 55, questsDone: 7 }),
  A('dot-21', 'p-fit', 'qa', 'haiku-5.5', 'running', { currentTaskId: 'q-e2e', currentAction: 'playwright — 12 of 18 specs', branch: 'test/closet-e2e', contextPct: 35, spendTodayUsd: 0.88, sessionShare: 0.02, level: 2, xp: 90, questsDone: 6 }),
  A('bram-16', 'p-tide', 'orchestrator', 'sonnet-5.5', 'paused', { contextPct: 12, spendTodayUsd: 0, sessionShare: 0, level: 2, xp: 10, questsDone: 4 }),
  A('quill-08', 'p-tide', 'custom', 'sonnet-5.5', 'paused', { contextPct: 9, spendTodayUsd: 0, sessionShare: 0, level: 2, xp: 30, questsDone: 3 }),
]

const Q = (q: Partial<Quest> & Pick<Quest, 'id' | 'projectId' | 'title' | 'status'>): Quest => ({
  brief: '', priority: 'normal', createdBy: 'atlas-01', dependsOn: [], acceptance: [], xpReward: 120, createdAt: iso(-8000), ...q,
})

export const quests: Quest[] = [
  Q({ id: 'q-mig', projectId: 'p-readable', title: 'Migration 0042 · reading_streaks', status: 'done', assigneeId: 'vex-07', xpReward: 80 }),
  Q({ id: 'q-api', projectId: 'p-readable', title: 'Reading streaks API', status: 'in_progress', assigneeId: 'vex-07', branch: 'feat/streaks-api', priority: 'high', dependsOn: ['q-mig'], xpReward: 200,
    brief: "Store each reader's streak and expose it to the UI and the reminder job. Rollover must follow the reader's own time zone, not the server's.",
    why: 'Your goal asks for streaks with daily reminders by Friday. The email job and the UI both read from this API.',
    acceptance: [
      { text: 'Migration 0042 with row-level security', done: true }, { text: 'GET / POST /api/streaks with zod validation', done: true },
      { text: "Rollover follows the reader's time zone", done: true }, { text: 'All streak tests green, no flakes in 5 runs', done: false },
      { text: 'PR opened against main and reviewed by QA', done: false }] }),
  Q({ id: 'q-ui', projectId: 'p-readable', title: 'Reading streaks UI', status: 'in_review', assigneeId: 'kip-03', branch: 'feat/reading-streaks', prNumber: 48, dependsOn: ['q-api'], xpReward: 180 }),
  Q({ id: 'q-mail', projectId: 'p-readable', title: 'Streak reminder email', status: 'in_progress', assigneeId: 'mira-12', branch: 'feat/streak-email', dependsOn: ['q-api'] }),
  Q({ id: 'q-prev', projectId: 'p-readable', title: 'Preview deploys per branch', status: 'blocked', assigneeId: 'rho-09', branch: 'infra/preview-deploys', dependsOn: ['q-api'] }),
  Q({ id: 'q-recap', projectId: 'p-readable', title: 'Weekly reading recap email', status: 'backlog', dependsOn: ['q-mail'] }),
  Q({ id: 'q-offline', projectId: 'p-readable', title: 'Offline highlights (spike)', status: 'backlog', createdBy: 'you' }),
  Q({ id: 'q-empty', projectId: 'p-readable', title: 'Reading list empty state', status: 'done', assigneeId: 'mira-12' }),
  Q({ id: 'q-auth', projectId: 'p-readable', title: 'Magic link auth', status: 'done', assigneeId: 'vex-07', xpReward: 200 }),
  Q({ id: 'q-plaid', projectId: 'p-moneo', title: 'Plaid sync retry', status: 'failed', assigneeId: 'tern-14', branch: 'fix/plaid-sync-retry', createdBy: 'sable-02' }),
  Q({ id: 'q-budget', projectId: 'p-moneo', title: 'Budget screen redesign', status: 'in_progress', assigneeId: 'lux-05', branch: 'feat/budget-v2', createdBy: 'sable-02' }),
  Q({ id: 'q-similar', projectId: 'p-fit', title: 'Outfit similarity search', status: 'in_progress', assigneeId: 'wren-11', branch: 'feat/similar-outfits', createdBy: 'onyx-04' }),
  Q({ id: 'q-photo', projectId: 'p-fit', title: 'Photo upload flow', status: 'in_progress', assigneeId: 'ash-06', branch: 'feat/photo-upload', createdBy: 'onyx-04' }),
  Q({ id: 'q-e2e', projectId: 'p-fit', title: 'E2E closet flows', status: 'in_progress', assigneeId: 'dot-21', branch: 'test/closet-e2e', createdBy: 'onyx-04' }),
]

export const alerts: Alert[] = [
  { id: 'a-crash', at: iso(-60), kind: 'crash', severity: 'critical', projectId: 'p-moneo', agentId: 'tern-14',
    title: 'Container ran out of memory (exit 137) while running Plaid sync tests',
    detail: '  RUNS  src/sync/plaid.retry.test.ts\nMark-Compact 3998.1 (4096.0) -> 3990.4 MB\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    actions: [{ id: 'restart-6gb', label: '↻ Restart with 6 GB', primary: true }, { id: 'restart', label: 'Restart as is' }, { id: 'reassign', label: '⇄ Give quest to another agent' }] },
  { id: 'a-merge', at: iso(-240), kind: 'approval', severity: 'needs_you', projectId: 'p-readable', agentId: 'kip-03',
    title: 'Merge feat/reading-streaks → main? (PR #48 · Reading streaks UI)', detail: '+412 −88 · 11 files · 145/145 tests · bundle 184 kB',
    actions: [{ id: 'approve', label: '✓ Approve & merge', primary: true, actsAsYou: true }, { id: 'review', label: 'Open review' }] },
  { id: 'a-question', at: iso(-540), kind: 'question', severity: 'needs_you', projectId: 'p-fit', agentId: 'ash-06',
    title: 'Outfit photos average 3 MB. Store them in Supabase Storage or Cloudinary? Paused on the upload flow until you choose.',
    actions: [{ id: 'reply:Supabase Storage', label: 'Supabase Storage' }, { id: 'reply:Cloudinary', label: 'Cloudinary' }, { id: 'reply:Ask Juno-22 to compare first', label: 'Ask a researcher' }] },
  { id: 'a-loop', at: iso(-660), kind: 'loop', severity: 'needs_you', projectId: 'p-fit', agentId: 'dot-21',
    title: 'Dot-21 ran the same failing spec 6 times in 4 min',
    actions: [{ id: 'take-control', label: '◆ Take control', primary: true, actsAsYou: true }, { id: 'nudge', label: 'Nudge' }, { id: 'dismiss', label: 'Let it continue' }] },
  { id: 'a-budget', at: iso(-720), kind: 'budget', severity: 'needs_you', projectId: 'p-moneo',
    title: 'Moneo used 85% of its $12.00 daily cap · agents pause at 100%',
    actions: [{ id: 'raise-cap', label: 'Raise to $15 today', primary: true }, { id: 'pause-base', label: 'Pause base' }, { id: 'dismiss', label: 'Dismiss' }] },
  { id: 'a-pace', at: iso(-300), kind: 'limit_pace', severity: 'heads_up',
    title: 'Session 62% · at this pace it runs out in ~1h 48m, 26 min before reset',
    actions: [{ id: 'downshift', label: 'Downshift workers to Haiku', primary: true }, { id: 'pause-noncritical', label: 'Pause non-critical' }] },
]

export const events: ActivityEvent[] = [
  { id: 'e1', at: iso(-360), agentId: 'mira-12', projectId: 'p-readable', kind: 'quest_complete', text: 'Quest complete: Reading list empty state · +120 XP' },
  { id: 'e2', at: iso(-240), agentId: 'kip-03', projectId: 'p-readable', kind: 'status', text: 'asked you to approve merge of PR #48' },
  { id: 'e3', at: iso(-60), agentId: 'rho-09', projectId: 'p-readable', kind: 'message', text: '→ Vex-07: ping me when migration 0042 lands', message: { to: 'vex-07', body: 'ping me when migration 0042 lands' } },
  { id: 'e4', at: iso(-60), agentId: 'tern-14', projectId: 'p-moneo', kind: 'status', text: 'Container exited 137 · OOM at 4.0 GB' },
  { id: 'e5', at: iso(-48), agentId: 'vex-07', projectId: 'p-readable', kind: 'tool', text: 'Read src/lib/streaks.ts', tool: { name: 'Read', target: 'src/lib/streaks.ts' } },
  { id: 'e6', at: iso(-40), agentId: 'juno-22', projectId: 'p-readable', kind: 'thought', text: 'foliate-js handles fixed-layout EPUB; epub.js does not' },
  { id: 'e7', at: iso(-22), agentId: 'mira-12', projectId: 'p-readable', kind: 'edit', text: 'created emails/StreakReminder.tsx (+64)', edit: { path: 'emails/StreakReminder.tsx', added: 64, removed: 0 } },
  { id: 'e8', at: iso(-15), agentId: 'atlas-01', projectId: 'p-readable', kind: 'handoff', text: '→ Mira-12: take "Streak reminder email"', message: { to: 'mira-12', body: 'take "Streak reminder email"' } },
  { id: 'e9', at: iso(-12), agentId: 'vex-07', projectId: 'p-readable', kind: 'command', text: 'npm test -- streaks', command: { cmd: 'npm test -- streaks', running: true, outputTail: 'Tests: 142 passed, 3 running, 145 total' } },
]

export const resources: Resources = {
  usage: { session: { usedPct: 62, resetsAt: iso(2 * 3600 + 14 * 60), ratePctPerHour: 21 }, weekly: { usedPct: 71, resetsAt: iso(3 * 86400 + 10 * 3600) }, syncedAt: iso(-32), source: 'connected' },
  spendTodayUsd: 38.4, dailyCapUsd: 60, spendMonthUsd: 612,
  containers: { running: 13, max: 24 },
  host: { cpuPct: 46, memUsedGb: 21.3, memTotalGb: 32, docker: 'running' },
}

export const guards: Guards = { warnAtPct: 70, pauseWorkersAtPct: 90, orchestratorReservePct: 5, weeklyWarnAtPct: 70, paceForecast: true, autoDownshiftAtPct: 85, resumeAfterReset: false }

export const mergeRequests: MergeRequest[] = [
  { id: 'mr-48', projectId: 'p-readable', branch: 'feat/reading-streaks', prNumber: 48, requestedBy: 'kip-03', status: 'pending' },
]

export const providers: ProviderView[] = [
  { id: 'claude-subscription', label: 'Claude subscription', kind: 'subscription', hasKey: true, models: [...BUILTIN_MODEL_IDS], status: 'connected' },
  { id: 'anthropic-api', label: 'Anthropic API', kind: 'anthropic', hasKey: true, keyHint: 'sk-…9f2c', models: [...BUILTIN_MODEL_IDS], status: 'untested' },
  { id: 'openai', label: 'OpenAI', kind: 'gateway', hasKey: false, models: [], status: 'missing_key' },
  { id: 'google', label: 'Google', kind: 'gateway', hasKey: false, models: [], status: 'missing_key' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'gateway', hasKey: false, models: [], status: 'missing_key' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', kind: 'gateway', hasKey: false, models: [], status: 'missing_key' },
]

/** Lines the simulation picks from to make the colony feel alive. */
export const SIM_LINES: Record<string, { kind: ActivityEvent['kind']; text: string }[]> = {
  backend: [{ kind: 'command', text: 'npm test -- streaks' }, { kind: 'tool', text: 'Read src/api/streaks.route.ts' }, { kind: 'edit', text: 'src/lib/streaks.ts (+6 −2)' }, { kind: 'thought', text: 'The rollover test still assumes UTC; injecting the clock.' }],
  frontend: [{ kind: 'edit', text: 'emails/StreakReminder.tsx (+12 −3)' }, { kind: 'tool', text: 'Read src/components/Toast.tsx' }, { kind: 'command', text: 'npm run lint' }, { kind: 'thought', text: 'Reusing the existing Toast keeps the bundle flat.' }],
  qa: [{ kind: 'command', text: 'npx playwright test closet' }, { kind: 'test', text: 'Tests · 12 passed · 0 failed · 6 running' }, { kind: 'tool', text: 'Read tests/closet.spec.ts' }],
  orchestrator: [{ kind: 'thought', text: 'Recap email needs a cron job; split into 3 quests.' }, { kind: 'handoff', text: '→ Juno-22: compare cron options on Supabase' }],
  researcher: [{ kind: 'tool', text: 'WebFetch supabase.com/docs/guides/cron' }, { kind: 'thought', text: 'pg_cron is enough for daily reminders.' }],
  devops: [{ kind: 'tool', text: 'Read .github/workflows/preview.yml' }],
  custom: [{ kind: 'thought', text: 'Idle.' }],
}
