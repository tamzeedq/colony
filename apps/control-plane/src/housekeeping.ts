// Housekeeping: finished work doesn't pile up forever (iteration 2 #18–20).
//   - done/failed quests are ARCHIVED (hidden, restorable) N days after they finished;
//   - dismissed/resolved Inbox items are removed N days after they were resolved;
//   - activity events older than N days are removed.
// Runs on boot and every few hours; "Clean up now" previews first. Settings live in kv.

import type { FastifyInstance } from 'fastify'
import type { HousekeepingPreview, HousekeepingSettings, Quest } from '@colony/shared'
import type { Db } from './db'
import { badRequest, notFound } from './errors'
import { ALERT_RETENTION_DAYS, nowIso, type Store } from './store'

export const DEFAULT_HOUSEKEEPING: HousekeepingSettings = { archiveQuestsAfterDays: 7, keepResolvedAlertsDays: ALERT_RETENTION_DAYS, keepEventsDays: 60 }
const KEY = 'housekeeping'
const DAY = 86_400_000
const isFinished = (q: Quest) => q.status === 'done' || q.status === 'failed'

export class HousekeepingService {
  private timer?: NodeJS.Timeout

  constructor(private store: Store, private db: Db, private now: () => number = Date.now) {
    store.alertRetentionDays = () => this.settings().keepResolvedAlertsDays
  }

  settings(): HousekeepingSettings { return { ...DEFAULT_HOUSEKEEPING, ...(this.db.kvGet<Partial<HousekeepingSettings>>(KEY) ?? {}) } }

  setSettings(patch: Partial<HousekeepingSettings>): HousekeepingSettings {
    const next = { ...this.settings(), ...patch }
    this.db.kvSet(KEY, next)
    return next
  }

  private questsToArchive(now: number): Quest[] {
    const days = this.settings().archiveQuestsAfterDays
    if (!days) return []
    const cutoff = new Date(now - days * DAY).toISOString()
    return [...this.store.quests.values()].filter((q) => isFinished(q) && !q.archivedAt && (q.finishedAt ?? q.createdAt) < cutoff)
  }

  preview(now = this.now()): HousekeepingPreview {
    const s = this.settings()
    const alertCut = s.keepResolvedAlertsDays ? new Date(now - s.keepResolvedAlertsDays * DAY).toISOString() : ''
    return {
      questsToArchive: this.questsToArchive(now).length,
      alertsToRemove: alertCut ? [...this.store.alerts.values()].filter((a) => a.resolvedAt && a.resolvedAt < alertCut).length : 0,
      eventsToRemove: s.keepEventsDays ? this.store.countEventsBefore(new Date(now - s.keepEventsDays * DAY).toISOString()) : 0,
    }
  }

  /** Apply the retention settings now. Returns what was done. */
  run(now = this.now()): HousekeepingPreview {
    const s = this.settings()
    const quests = this.questsToArchive(now)
    const at = nowIso()
    for (const q of quests) this.store.saveQuest({ ...q, archivedAt: at })
    const alertsToRemove = this.store.pruneResolvedAlerts(now)
    const eventsToRemove = s.keepEventsDays ? this.store.pruneEventsBefore(new Date(now - s.keepEventsDays * DAY).toISOString()) : 0
    if (quests.length || alertsToRemove) this.store.broadcastSnapshot()
    return { questsToArchive: quests.length, alertsToRemove, eventsToRemove }
  }

  /** "Archive finished" on a base: archive every done/failed quest there now. */
  archiveFinished(projectId: string): { archived: number } {
    if (!this.store.projects.has(projectId)) throw notFound('project')
    const at = nowIso()
    let archived = 0
    for (const q of this.store.projectQuests(projectId)) {
      if (isFinished(q) && !q.archivedAt) { this.store.saveQuest({ ...q, archivedAt: at }); archived++ }
    }
    if (archived) this.store.broadcastSnapshot()
    return { archived }
  }

  setArchived(questId: string, archived: boolean): Quest {
    const q = this.store.quests.get(questId)
    if (!q) throw notFound('quest')
    if (archived && !isFinished(q)) throw badRequest('only done or failed quests can be archived')
    const next: Quest = archived ? { ...q, archivedAt: q.archivedAt ?? nowIso() } : (({ archivedAt: _a, ...rest }) => rest)(q)
    this.store.saveQuest(next)
    this.store.broadcastSnapshot()
    return this.store.quests.get(questId)!
  }

  start(everyMs = 6 * 3600_000) {
    this.stop()
    try { this.run() } catch { /* never block boot */ }
    this.timer = setInterval(() => { try { this.run() } catch { /* next time */ } }, everyMs)
    this.timer.unref?.()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined }
}

export function registerHousekeepingRoutes(app: FastifyInstance, hk: HousekeepingService, store: Store) {
  const days = (v: unknown, k: string) => {
    if (v === undefined) return undefined
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 3650) throw badRequest(`'${k}' must be a whole number of days, 0–3650 (0 = never)`)
    return v
  }
  app.get('/api/housekeeping', async () => ({ settings: hk.settings(), preview: hk.preview() }))
  app.put('/api/housekeeping', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    for (const k of Object.keys(b)) if (!['archiveQuestsAfterDays', 'keepResolvedAlertsDays', 'keepEventsDays'].includes(k)) throw badRequest(`unknown field '${k}'`)
    const patch: Partial<HousekeepingSettings> = {}
    for (const k of ['archiveQuestsAfterDays', 'keepResolvedAlertsDays', 'keepEventsDays'] as const) { const v = days(b[k], k); if (v !== undefined) patch[k] = v }
    return { settings: hk.setSettings(patch), preview: hk.preview() }
  })
  app.post('/api/housekeeping/run', async () => hk.run())
  app.post('/api/projects/:id/quests/archive-finished', async (req) => hk.archiveFinished(String((req.params as { id: string }).id)))
  app.post('/api/quests/:id/archive', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    if (typeof b.archived !== 'boolean') throw badRequest("send 'archived' (boolean)")
    return hk.setArchived(String((req.params as { id: string }).id), b.archived)
  })
  app.delete('/api/alerts/resolved', async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId
    return { removed: store.clearResolvedAlerts(projectId || undefined) }
  })
}
