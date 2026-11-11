// Alert & sound preferences (docs/phase5.md "Sound"). Per-viewer, persisted in localStorage under
// `colony.alertPrefs`. Every storage access is guarded: private windows or blocked storage fall back
// to the defaults, and the app behaves exactly as before Phase 5.
import { useSyncExternalStore } from 'react'
import type { AlertSeverity } from '@/types/colony'

export type AlertCategory = 'critical' | 'needs_you' | 'quest_complete' | 'heads_up'
export const ALERT_CATEGORIES: readonly AlertCategory[] = ['critical', 'needs_you', 'quest_complete', 'heads_up']

export interface CategoryPrefs { toast: boolean; banner: boolean; sound: boolean }

export interface AlertPrefs {
  categories: Record<AlertCategory, CategoryPrefs>
  /** 0–1, applied to the single master gain. */
  masterVolume: number
  quietInTakeControl: boolean
  /** Local "HH:MM" times; the window may wrap past midnight. Critical still plays. */
  quietHours: { enabled: boolean; start: string; end: string }
}

const KEY = 'colony.alertPrefs'

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  categories: {
    critical: { toast: true, banner: true, sound: true },
    needs_you: { toast: true, banner: false, sound: true },
    quest_complete: { toast: false, banner: false, sound: true },
    heads_up: { toast: false, banner: false, sound: false },
  },
  masterVolume: 0.6,
  quietInTakeControl: true,
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
}

const isTime = (v: unknown): v is string => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)

/** Merge whatever was stored over the defaults, field by field, so old or partial data is safe. */
function normalize(raw: unknown): AlertPrefs {
  const d = DEFAULT_ALERT_PREFS
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Partial<Record<keyof AlertPrefs, unknown>>
  const cats = (r.categories && typeof r.categories === 'object' ? r.categories : {}) as Record<string, Partial<CategoryPrefs> | undefined>
  const categories = Object.fromEntries(ALERT_CATEGORIES.map((c) => {
    const s = cats[c] ?? {}
    return [c, { toast: bool(s.toast, d.categories[c].toast), banner: bool(s.banner, d.categories[c].banner), sound: bool(s.sound, d.categories[c].sound) }]
  })) as AlertPrefs['categories']
  const qh = (r.quietHours && typeof r.quietHours === 'object' ? r.quietHours : {}) as Partial<AlertPrefs['quietHours']>
  const vol = typeof r.masterVolume === 'number' && Number.isFinite(r.masterVolume) ? Math.min(1, Math.max(0, r.masterVolume)) : d.masterVolume
  return {
    categories, masterVolume: vol,
    quietInTakeControl: bool(r.quietInTakeControl, d.quietInTakeControl),
    quietHours: { enabled: bool(qh.enabled, d.quietHours.enabled), start: isTime(qh.start) ? qh.start : d.quietHours.start, end: isTime(qh.end) ? qh.end : d.quietHours.end },
  }
}

function load(): AlertPrefs {
  try {
    const s = localStorage.getItem(KEY)
    return s ? normalize(JSON.parse(s)) : DEFAULT_ALERT_PREFS
  } catch {
    return DEFAULT_ALERT_PREFS
  }
}

let current: AlertPrefs = load()
const listeners = new Set<() => void>()

export const getAlertPrefs = (): AlertPrefs => current

export function setAlertPrefs(next: AlertPrefs | ((p: AlertPrefs) => AlertPrefs)) {
  current = normalize(typeof next === 'function' ? next(current) : next)
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* storage blocked: keep in memory */ }
  listeners.forEach((fn) => fn())
}

export function setCategoryPref(cat: AlertCategory, patch: Partial<CategoryPrefs>) {
  setAlertPrefs((p) => ({ ...p, categories: { ...p.categories, [cat]: { ...p.categories[cat], ...patch } } }))
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  // Another tab changed the prefs.
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { current = load(); fn() } }
  window.addEventListener('storage', onStorage)
  return () => { listeners.delete(fn); window.removeEventListener('storage', onStorage) }
}

/** Current prefs plus a setter; re-renders when they change (here or in another tab). */
export function useAlertPrefs(): [AlertPrefs, typeof setAlertPrefs] {
  const prefs = useSyncExternalStore(subscribe, getAlertPrefs, getAlertPrefs)
  return [prefs, setAlertPrefs]
}

export const categoryForSeverity = (s: AlertSeverity): AlertCategory => s

/** True when "now" falls inside the quiet-hours window (handles windows that wrap midnight). */
export function inQuietHours(p: AlertPrefs, now = new Date()): boolean {
  if (!p.quietHours.enabled) return false
  const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
  const s = mins(p.quietHours.start), e = mins(p.quietHours.end), n = now.getHours() * 60 + now.getMinutes()
  if (s === e) return false
  return s < e ? n >= s && n < e : n >= s || n < e
}
