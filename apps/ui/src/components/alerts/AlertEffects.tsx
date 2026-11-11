// Always-mounted watcher for alert side effects (docs/phase5.md "Sound", "Desktop notifications"):
// sound cues, the 60 s critical repeat, quest-complete batching and desktop notifications.
// Toasts and the banner render elsewhere (Toasts.tsx); this component renders nothing.
//
// Only alerts and events that arrive after mount count. AppShell mounts once the snapshot is in, so
// everything present at first render is the hydrated backlog and is ignored.
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, mergeRequestForAlert } from '@/store/store'
import { useSound } from '@/hooks/useSound'
import { getAlertPrefs, type AlertCategory } from '@/lib/alertPrefs'
import type { ActivityEvent, Alert, ID } from '@/types/colony'

const REPEAT_MS = 60_000
const QUEST_BATCH_MS = 2_000
/** Events older than this before mount are backlog (a resync re-emits them). */
const BACKLOG_SLACK_MS = 10_000

const attending = () => typeof document !== 'undefined' && !document.hidden && document.hasFocus()

export function AlertEffects() {
  const { state, subscribe, seedEvents, dispatch } = useStore()
  const { play } = useSound()
  const nav = useNavigate()
  const stateRef = useRef(state)
  stateRef.current = state
  const navRef = useRef(nav)
  navRef.current = nav

  // ── alerts ──
  const known = useRef<Set<ID> | null>(null)
  if (!known.current) known.current = new Set(state.alerts.map((a) => a.id))
  const notified = useRef(new Set<ID>())
  /** Pending critical repeats: alert id → { seen since it arrived, timer }. */
  const pendingCrit = useRef(new Map<ID, { seen: boolean; timer: ReturnType<typeof setTimeout> }>())

  useEffect(() => {
    const fresh: Alert[] = []
    for (const a of state.alerts) {
      if (known.current!.has(a.id)) continue
      known.current!.add(a.id)
      if (!a.resolvedAt) fresh.push(a)
    }
    if (!fresh.length) return

    // One cue per category per batch (a resync can bring several at once), loudest first.
    const cats = new Set<AlertCategory>(fresh.map((a) => a.severity))
    for (const c of ['critical', 'needs_you', 'heads_up'] as const) if (cats.has(c)) { play(c); break }

    for (const a of fresh) {
      if (a.severity === 'critical') {
        const timer = setTimeout(() => {
          const p = pendingCrit.current.get(a.id)
          pendingCrit.current.delete(a.id)
          const still = stateRef.current.alerts.find((x) => x.id === a.id)
          if (p && !p.seen && still && !still.resolvedAt) play('critical')
        }, REPEAT_MS)
        pendingCrit.current.set(a.id, { seen: attending(), timer })
      }
      if (a.severity === 'critical' || a.severity === 'needs_you') notify(a)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.alerts, play])

  // Looking at the app counts as having seen pending criticals.
  useEffect(() => {
    const mark = () => { if (attending()) pendingCrit.current.forEach((p) => { p.seen = true }) }
    document.addEventListener('visibilitychange', mark)
    window.addEventListener('focus', mark)
    const pending = pendingCrit.current
    return () => {
      document.removeEventListener('visibilitychange', mark)
      window.removeEventListener('focus', mark)
      pending.forEach((p) => clearTimeout(p.timer))
      pending.clear()
    }
  }, [])

  function notify(a: Alert) {
    if (typeof document === 'undefined' || !document.hidden) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    if (notified.current.has(a.id)) return
    notified.current.add(a.id)
    const s = stateRef.current
    const base = s.projects.find((p) => p.id === a.projectId)?.name
    try {
      const n = new Notification(a.title, { body: [a.detail, base].filter(Boolean).join(' · '), tag: `colony-${a.id}` })
      n.onclick = () => {
        window.focus()
        const mr = a.kind === 'approval' ? mergeRequestForAlert(stateRef.current, a) : undefined
        navRef.current(mr ? `/review/${mr.id}` : `/inbox#${a.id}`)
        n.close()
      }
    } catch { /* some browsers only allow notifications from a service worker */ }
  }

  // ── quest_complete events, batched within 2 s ──
  const levels = useRef(new Map<ID, number>())
  const leveledAt = useRef(new Map<ID, number>())
  useEffect(() => {
    for (const a of state.agents) {
      const prev = levels.current.get(a.id)
      if (prev !== undefined && a.level > prev) leveledAt.current.set(a.id, Date.now())
      levels.current.set(a.id, a.level)
    }
  }, [state.agents])

  useEffect(() => {
    const mountedAt = Date.now()
    const seen = new Set(seedEvents.map((e) => e.id))
    let batch: { e: ActivityEvent; level?: number }[] = []
    let timer: ReturnType<typeof setTimeout> | undefined

    const flush = () => {
      timer = undefined
      const items = batch
      batch = []
      if (!items.length) return
      const now = Date.now()
      const levelUp = items.some(({ e, level }) => {
        const ag = stateRef.current.agents.find((x) => x.id === e.agentId)
        return /\blevel(?:ed)?[\s-]*(?:up|\d+)/i.test(e.text)
          || (ag && level !== undefined && ag.level > level)
          || now - (leveledAt.current.get(e.agentId) ?? 0) < QUEST_BATCH_MS + 3_000
      })
      play('quest_complete', { levelUp })
      if (getAlertPrefs().categories.quest_complete.toast) {
        const title = items.length === 1 ? items[0].e.text : `${items.length} quests complete`
        void dispatch({ type: 'toast', toast: { id: `qc-${items[0].e.id}`, title, tone: 'done', at: now } })
      }
    }

    const off = subscribe((e) => {
      if (seen.has(e.id)) return
      seen.add(e.id)
      if (e.kind !== 'quest_complete') return
      const at = Date.parse(e.at)
      if (Number.isFinite(at) && at < mountedAt - BACKLOG_SLACK_MS) return
      batch.push({ e, level: stateRef.current.agents.find((x) => x.id === e.agentId)?.level })
      if (!timer) timer = setTimeout(flush, QUEST_BATCH_MS)
    })
    return () => { off(); clearTimeout(timer) }
    // seedEvents is a getter read once at mount on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, play, dispatch])

  return null
}
