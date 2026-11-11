// Key moments on the base map (docs/phase5.md "Key moments"):
//   spawn           a station that enters after the map hydrated pops in (animate-pop)
//   crash           a station entering `error` shakes once (animate-shake)
//   quest complete  a "+N XP" chip floats up from the station over 900 ms (celebrate);
//                   "Level N" when the agent's level rose
// All skipped under reduced motion.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityEvent, Agent, AgentStatus } from '@/types/colony'

const POP_MS = 400        // motion.slow (spawn)
const SHAKE_MS = 800      // animate-shake: 0.4 s × 2
const CELEBRATE_MS = 900  // motion.celebrate (XP chip)
const LEVEL_MERGE_MS = 2000

export interface Chip { id: string; agentId: string; text: string; at: number }

/** "+120 XP" from the control plane's quest_complete text ("… (+120 XP)"). */
export function xpFromText(text: string): number | undefined {
  const m = /\+\s*(\d+)\s*XP/i.exec(text)
  return m ? Number(m[1]) : undefined
}

interface Options {
  projectId: string
  agents: Agent[]
  /** Moments only start once the data is in (so hydrating never pops every station). */
  ready: boolean
  reduced: boolean
  /** Fresh events only (newer than mount). */
  subscribeFresh: (fn: (e: ActivityEvent) => void) => () => void
}

export function useMapMoments({ projectId, agents, ready, reduced, subscribeFresh }: Options) {
  const [motion, setMotion] = useState<Record<string, string>>({})
  const [chips, setChips] = useState<Chip[]>([])
  const known = useRef<{ project: string; ids: Set<string>; status: Map<string, AgentStatus>; level: Map<string, number> } | null>(null)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const chipsRef = useRef(chips)
  chipsRef.current = chips

  const later = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.current.delete(t); fn() }, ms)
    timers.current.add(t)
  }, [])
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear() }, [])

  const flash = useCallback((id: string, cls: string, ms: number) => {
    setMotion((m) => ({ ...m, [id]: cls }))
    later(ms, () => setMotion((m) => { if (m[id] !== cls) return m; const n = { ...m }; delete n[id]; return n }))
  }, [later])

  const addChip = useCallback((agentId: string, text: string) => {
    const id = `${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setChips((c) => [...c.slice(-8), { id, agentId, text, at: Date.now() }])
    later(CELEBRATE_MS + 50, () => setChips((c) => c.filter((x) => x.id !== id)))
  }, [later])

  // Spawn pop, crash shake, level-up chip: diff the roster against what we saw last render.
  useEffect(() => {
    if (!ready) return
    const k = known.current
    const snapshot = () => ({
      project: projectId,
      ids: new Set(agents.map((a) => a.id)),
      status: new Map(agents.map((a) => [a.id, a.status] as const)),
      level: new Map(agents.map((a) => [a.id, a.level] as const)),
    })
    if (!k || k.project !== projectId) { known.current = snapshot(); return }
    if (!reduced) {
      for (const a of agents) {
        if (!k.ids.has(a.id)) { flash(a.id, 'animate-pop', POP_MS); continue }
        if (a.status === 'error' && k.status.get(a.id) !== 'error') flash(a.id, 'animate-shake', SHAKE_MS)
        const was = k.level.get(a.id)
        if (was != null && a.level > was) {
          const text = `Level ${a.level}`
          // A quest chip that just went up for this agent becomes the level-up chip.
          const recent = [...chipsRef.current].reverse().find((c) => c.agentId === a.id && Date.now() - c.at < LEVEL_MERGE_MS)
          if (recent) setChips((cs) => cs.map((c) => (c.id === recent.id ? { ...c, text } : c)))
          else addChip(a.id, text)
        }
      }
    }
    known.current = snapshot()
  }, [agents, projectId, ready, reduced, flash, addChip])

  // Quest complete chips.
  useEffect(() => {
    if (reduced) return
    return subscribeFresh((e) => {
      if (e.kind !== 'quest_complete' || e.projectId !== projectId) return
      if (!agentsRef.current.some((a) => a.id === e.agentId)) return
      const xp = xpFromText(e.text)
      addChip(e.agentId, xp != null ? `+${xp} XP` : 'Quest complete')
    })
  }, [subscribeFresh, projectId, reduced, addChip])

  return { motion, chips }
}

/** A chip floating up ~40px and fading out over 900 ms, centred above a station's top edge. */
export function XpChip({ chip, x, y }: { chip: Chip; x: number; y: number }) {
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof el.animate !== 'function') return
    el.animate(
      [
        { transform: 'translate(-50%, 0) scale(.9)', opacity: 0 },
        { transform: 'translate(-50%, -8px) scale(1)', opacity: 1, offset: 0.15 },
        { transform: 'translate(-50%, -28px) scale(1)', opacity: 1, offset: 0.6 },
        { transform: 'translate(-50%, -40px) scale(1)', opacity: 0 },
      ],
      { duration: CELEBRATE_MS, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'forwards' },
    )
  }, [])
  const level = chip.text.startsWith('Level')
  return (
    <div ref={ref} aria-hidden="true"
      className={`pointer-events-none absolute z-10 whitespace-nowrap rounded-full border px-2.5 py-0.5 font-display text-[13px] font-bold shadow-raised ${level ? 'border-you/60 bg-you text-you-ink' : 'border-st-done/50 bg-surface text-st-done'}`}
      style={{ left: x, top: y, transform: 'translate(-50%, 0)', opacity: 0 }}>
      {chip.text}
    </div>
  )
}
