// Typed calls for every control-plane route the UI uses (docs/phase2.md "UI action → API").
import type { ActivityEvent, Agent, Alert, Guards, ID, MergeRequest, ModelId, Project, ProviderId, ProviderView, Quest, RoleId, Snapshot, SupabaseDetails, SupabaseInfo } from '@/types/colony'
import { api, apiText, enc } from './client'

export interface SpawnInput { role: RoleId; model?: ModelId; callsign?: string; task?: string; budgetCapUsd?: number; rolePrompt?: string }
export interface QuestInput { title: string; brief?: string; priority?: Quest['priority']; acceptance?: string[] }
export interface QuestPatch { status?: Quest['status']; title?: string; brief?: string; priority?: Quest['priority'] }
export interface ProjectInput { name: string; goal?: string; stack?: string[]; repoUrl?: string; dailyCapUsd?: number; supabase?: boolean; supabaseStudio?: boolean }
export type SupabaseAction = 'start' | 'stop' | 'reset'

const a = (id: ID) => `/api/agents/${enc(id)}`

export const endpoints = {
  snapshot: () => api<Snapshot & { guards?: Guards }>('GET', '/api/snapshot'),

  // agents
  pause: (id: ID) => api<Agent>('POST', `${a(id)}/pause`),
  resume: (id: ID) => api<Agent>('POST', `${a(id)}/resume`),
  pauseAll: () => api('POST', '/api/agents/pause-all'),
  kill: (id: ID) => api('DELETE', a(id)),
  restart: (id: ID) => api<Agent>('POST', `${a(id)}/restart`),
  patchAgent: (id: ID, patch: { model?: ModelId; rolePrompt?: string; budgetCapUsd?: number }) => api<Agent>('PATCH', a(id), patch),
  takeControl: (id: ID) => api<Agent>('POST', `${a(id)}/take-control`),
  handBack: (id: ID, note?: string) => api<Agent>('POST', `${a(id)}/hand-back`, note ? { note } : {}),
  message: (id: ID, text: string) => api('POST', `${a(id)}/message`, { text }),
  agentEvents: (id: ID, limit = 200) => api<ActivityEvent[]>('GET', `${a(id)}/events?limit=${limit}`),
  spawn: (projectId: ID, input: SpawnInput) => api<Agent>('POST', `/api/projects/${enc(projectId)}/agents`, input),

  // projects
  createProject: (input: ProjectInput) => api<Project>('POST', '/api/projects', input),
  patchProject: (id: ID, patch: { goal?: string; dailyCapUsd?: number }) => api<Project>('PATCH', `/api/projects/${enc(id)}`, patch),
  diff: (projectId: ID, branch: string) => apiText(`/api/projects/${enc(projectId)}/diff?branch=${enc(branch)}`),

  // dev Supabase (docs/phase4.md "HTTP"). start/stop/reset answer 202 and finish in the background.
  supabaseDetails: (projectId: ID) => api<SupabaseDetails>('GET', `/api/projects/${enc(projectId)}/supabase`),
  supabaseAction: (projectId: ID, action: SupabaseAction) =>
    api<Partial<SupabaseInfo> | undefined>('POST', `/api/projects/${enc(projectId)}/supabase/${action}`, action === 'reset' ? { confirm: true } : undefined),
  setSupabaseStudio: (projectId: ID, studio: boolean) => api<Partial<SupabaseInfo> | undefined>('PATCH', `/api/projects/${enc(projectId)}/supabase`, { studio }),

  // quests (docs/phase3.md "Quest lifecycle")
  createQuest: (projectId: ID, body: QuestInput) => api<Quest>('POST', `/api/projects/${enc(projectId)}/quests`, body),
  patchQuest: (id: ID, body: QuestPatch) => api<Quest>('PATCH', `/api/quests/${enc(id)}`, body),

  // guards
  getGuards: () => api<Guards>('GET', '/api/guards'),
  patchGuards: (patch: Partial<Guards>) => api<Guards>('PATCH', '/api/guards', patch),

  // alerts
  resolveAlert: (id: ID) => api<Alert>('POST', `/api/alerts/${enc(id)}/resolve`),

  // merge requests
  approveMerge: (id: ID) => api<{ mergeRequest?: MergeRequest } & Partial<MergeRequest>>('POST', `/api/merge-requests/${enc(id)}/approve`),
  requestChanges: (id: ID, note: string) => api<{ mergeRequest?: MergeRequest } & Partial<MergeRequest>>('POST', `/api/merge-requests/${enc(id)}/request-changes`, { note }),

  // providers
  providers: () => api<ProviderView[] | { providers: ProviderView[] }>('GET', '/api/providers'),
  putProvider: (id: ProviderId, body: { apiKey?: string; baseUrl?: string; models?: string[] }) => api<ProviderView>('PUT', `/api/providers/${enc(id)}`, body),
  deleteProviderKey: (id: ProviderId) => api<ProviderView>('DELETE', `/api/providers/${enc(id)}/key`),
  testProvider: (id: ProviderId) => api<ProviderView & { ok?: boolean; error?: string; provider?: ProviderView }>('POST', `/api/providers/${enc(id)}/test`),
}

/** Pull a MergeRequest out of an approve / request-changes response (either shape). */
export function mergeRequestFrom(r: unknown): MergeRequest | undefined {
  const o = r as { mergeRequest?: MergeRequest } & Partial<MergeRequest> | undefined
  if (o?.mergeRequest?.id) return o.mergeRequest
  if (o?.id && o.branch) return o as MergeRequest
  return undefined
}

/** Pull a Quest out of a create / patch response (bare or wrapped as `{ quest }`). */
export function questFrom(r: unknown): Quest | undefined {
  const o = r as { quest?: Quest } & Partial<Quest> | undefined
  if (o?.quest?.id) return o.quest
  if (o?.id && o.projectId && o.title) return o as Quest
  return undefined
}
