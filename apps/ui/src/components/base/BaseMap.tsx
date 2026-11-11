// The base view (docs/phase5.md "Base map canvas"). Stations are HTML (crisp, clickable,
// accessible) in an overlay that shares one camera with a PixiJS layer underneath, which draws
// the grid, links, marching dashes, handoff pulses and the spawn ghost (MapScene.ts).
// Fallback (reduced motion, or no WebGL): the CSS link lines below, no pan/zoom/pulses.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEvent, Agent, Project } from '@/types/colony'
import { STATUS, ROLES, modelInfo } from '@/design/status'
import { useStore, projectAgents } from '@/store/store'
import { Bar } from '@/components/ui/controls'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cx } from '@/lib/util'
import { MapScene, type Camera, type Point, type SceneModel } from './MapScene'
import { useMapCamera } from './useMapCamera'
import { useMapMoments, XpChip } from './MapMoments'

const W = 960, H = 520, CX = W / 2, CY = H / 2
const WORLD = { w: W, h: H }
const HUB: Point = { x: CX, y: CY }
const LIVE = new Set(['running', 'editing', 'thinking', 'booting'])
// Half-sizes of the HTML cards (HqCard 250 wide, StationCard 196 wide), plus a little air.
const HQ_HALF = { w: 129, h: 66 }, STATION_HALF = { w: 102, h: 54 }

/** Where the segment from `from` (centre of a w×h box) to `to` leaves the box. */
function boxExit(from: Point, to: Point, half: { w: number; h: number }): Point {
  const dx = to.x - from.x, dy = to.y - from.y
  const t = Math.min(dx ? half.w / Math.abs(dx) : Infinity, dy ? half.h / Math.abs(dy) : Infinity, 1)
  return { x: from.x + dx * t, y: from.y + dy * t }
}

/** A pulse path that only crosses the visible gaps between cards (not under them). */
function visiblePath(stops: Point[]): Point[] {
  const half = (p: Point) => (p === HUB ? HQ_HALF : STATION_HALF)
  const out: Point[] = []
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1]
    out.push(boxExit(a, b, half(a)), boxExit(b, a, half(b)))
  }
  return out
}
const FOLLOW_WINDOW_MS = 20_000
const FRESH_MS = 15_000 // events older than this (e.g. a resync backlog) never animate
const STATION = { w: 196, h: 100, left: 98, top: 50 } // card box relative to its anchor
const HQ_TOP = 62

export function BaseMap({ project, height = 520 }: { project: Project; height?: number }) {
  const { state, dispatch, subscribe, seedEvents, conn } = useStore()
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [failed, setFailed] = useState(false)
  const canvasMode = !reduced && !failed
  const [ready, setReady] = useState(false) // Pixi is up and drawing
  const [follow, setFollow] = useState(false)

  const all = useMemo(() => projectAgents(state, project), [state.agents, project.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const hq = all.find((a) => a.id === project.orchestratorId) ?? all.find((a) => a.role === 'orchestrator')
  const pos = useMemo(() => {
    const workers = all.filter((a) => a !== hq)
    return workers.map((a, i) => {
      const ang = (-90 + (360 * (i + 0.5)) / Math.max(1, workers.length)) * (Math.PI / 180)
      return { a, x: CX + 330 * Math.cos(ang), y: CY + 175 * Math.sin(ang) }
    })
  }, [all, hq])

  // World positions by agent id (HQ at the hub), read by event handlers.
  const points = useRef(new Map<string, Point>())
  const hqId = useRef<string | undefined>(undefined)
  points.current = new Map(pos.map(({ a, x, y }) => [a.id, { x, y }]))
  if (hq) points.current.set(hq.id, HUB)
  hqId.current = hq?.id

  // ── fresh events: newer than mount, never a hydrate/resync backlog, each id once ──
  const mountAt = useRef(Date.now())
  const subscribeFresh = useCallback((fn: (e: ActivityEvent) => void) => {
    const seen = new Set<string>()
    return subscribe((e) => {
      const t = Date.parse(e.at)
      if (!(t >= mountAt.current - 1000 && t >= Date.now() - FRESH_MS) || seen.has(e.id)) return
      if (seen.size > 2000) seen.clear()
      seen.add(e.id)
      fn(e)
    })
  }, [subscribe])

  // ── camera + Pixi scene ──
  const sectionRef = useRef<HTMLElement | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const canvasHostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<MapScene | null>(null)
  const apply = useCallback((c: Camera) => {
    if (overlayRef.current) overlayRef.current.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.scale})`
    sceneRef.current?.setCamera(c)
  }, [])
  const camera = useMapCamera({ enabled: canvasMode && ready, world: WORLD, apply, onManual: () => setFollow(false) })
  const { hostRef, setSize, easeTo, fit, cam } = camera
  const setSectionRef = useCallback((el: HTMLElement | null) => { sectionRef.current = el; hostRef.current = el }, [hostRef])

  // Size the camera before paint, then follow the container (ResizeObserver).
  useLayoutEffect(() => {
    const el = sectionRef.current
    if (!canvasMode || !el) return
    const sync = () => {
      setSize(el.clientWidth, el.clientHeight)
      sceneRef.current?.resize(el.clientWidth, el.clientHeight)
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [canvasMode, setSize])

  // What Pixi draws, measured from the real cards so the spawn ghost hugs them.
  const model = useRef<SceneModel>({ hub: HUB, workers: [] })
  useLayoutEffect(() => {
    const overlay = overlayRef.current
    model.current = {
      hub: HUB,
      workers: pos.map(({ a, x, y }) => {
        const el = overlay?.querySelector<HTMLElement>(`[data-station="${CSS.escape(a.id)}"]`)
        const box = { x: x - STATION.left, y: y - STATION.top, w: el?.offsetWidth || STATION.w, h: el?.offsetHeight || STATION.h }
        return { id: a.id, x, y, status: a.status, box }
      }),
    }
    sceneRef.current?.setModel(model.current)
  }, [pos, ready])

  // One Pixi Application per mounted map; init is async, so guard against unmount meanwhile.
  useEffect(() => {
    const host = canvasHostRef.current
    if (!canvasMode || !host) return
    const scene = new MapScene()
    let live = true
    void scene.init(host, host.clientWidth, host.clientHeight).then((ok) => {
      if (!live) return
      if (!ok) { setFailed(true); return }
      sceneRef.current = scene
      scene.setCamera(cam.current)
      scene.setModel(model.current)
      setReady(true)
    })
    return () => {
      live = false
      if (sceneRef.current === scene) sceneRef.current = null
      scene.destroy()
      setReady(false)
    }
  }, [canvasMode, cam])

  // Handoff pulses: handoff → HQ to the assignee; message → sender to recipient (via HQ between workers).
  useEffect(() => {
    if (!ready) return
    return subscribeFresh((e) => {
      if (e.projectId !== project.id) return
      const pts = points.current
      const isHq = (id: string) => id === hqId.current
      const at = (id: string) => (isHq(id) ? HUB : pts.get(id))
      let path: Point[] | null = null
      if (e.kind === 'handoff') {
        const to = e.message?.to ?? e.agentId
        const p = isHq(to) ? undefined : pts.get(to)
        if (p) path = [HUB, p]
      } else if (e.kind === 'message' && e.message?.to && e.message.to !== e.agentId) {
        const a = at(e.agentId), b = at(e.message.to)
        if (a && b) path = isHq(e.agentId) || isHq(e.message.to) ? [a, b] : [a, HUB, b]
      }
      if (path) sceneRef.current?.pulse(visiblePath(path))
    })
  }, [ready, subscribeFresh, project.id])

  // Follow activity: count events per station over the last 20 s; ease to the busiest.
  const activity = useRef<{ id: string; t: number }[]>([])
  useEffect(() => {
    const now = Date.now()
    activity.current = seedEvents
      .filter((e) => e.projectId === project.id && now - Date.parse(e.at) < FOLLOW_WINDOW_MS)
      .map((e) => ({ id: e.agentId, t: Date.parse(e.at) }))
    return subscribe((e) => {
      if (e.projectId !== project.id) return
      const a = activity.current
      a.push({ id: e.agentId, t: Date.now() })
      if (a.length > 500) a.splice(0, a.length - 500)
    })
  }, [subscribe, project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!follow || !ready) return
    const tick = () => {
      const cutoff = Date.now() - FOLLOW_WINDOW_MS
      activity.current = activity.current.filter((x) => x.t >= cutoff)
      const counts = new Map<string, number>()
      for (const x of activity.current) if (points.current.has(x.id)) counts.set(x.id, (counts.get(x.id) ?? 0) + 1)
      let best: string | undefined, n = 0
      counts.forEach((c, id) => { if (c > n) { n = c; best = id } })
      const p = best ? points.current.get(best) : undefined
      if (p) easeTo(p)
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [follow, ready, easeTo])

  // ── key moments ──
  const { motion, chips } = useMapMoments({ projectId: project.id, agents: all, ready: conn.hydrated, reduced, subscribeFresh })

  const questCount = state.quests.filter((q) => q.projectId === project.id && q.status !== 'done').length
  const world = (
    <>
      {!ready && pos.map(({ a, x, y }) => {
        const dx = x - CX, dy = y - CY
        const s = STATUS[a.status]
        return (
          <div key={`l-${a.id}`} aria-hidden="true"
            className={cx('absolute h-0.5 origin-left', LIVE.has(a.status) ? cx('link-live', s.text) : 'bg-line')}
            style={{ left: CX, top: CY, width: Math.hypot(dx, dy), transform: `rotate(${Math.atan2(dy, dx)}rad)` }} />
        )
      })}
      {hq && <HqCard agent={hq} x={CX} y={CY} questCount={questCount} className={motion[hq.id]} />}
      {pos.map(({ a, x, y }) => <StationCard key={a.id} agent={a} x={x} y={y} className={motion[a.id]} onOpen={() => dispatch({ type: 'inspect', id: a.id })} selected={state.ui.inspectAgentId === a.id} />)}
      {!hq && (
        <div className="absolute grid h-[84px] w-[190px] place-items-center rounded-xl border-2 border-dashed border-line-strong font-display font-semibold text-ink-dim" style={{ left: CX - 95, top: CY - 42 }}>HQ is empty</div>
      )}
      {chips.map((c) => {
        const p = points.current.get(c.agentId)
        if (!p) return null
        return <XpChip key={c.id} chip={c} x={p.x} y={p.y - (c.agentId === hq?.id ? HQ_TOP : STATION.top) - 14} />
      })}
    </>
  )

  return (
    <section ref={setSectionRef} aria-label={`${project.name} base map`}
      className={cx('relative overflow-hidden bg-well',
        !ready && 'bg-[radial-gradient(var(--color-line-soft)_1px,transparent_1px)] bg-[length:22px_22px]',
        ready && 'cursor-grab touch-none select-none data-[dragging=true]:cursor-grabbing')}
      style={{ height }}>
      {canvasMode && <div ref={canvasHostRef} aria-hidden="true" className="absolute inset-0" />}
      {canvasMode ? (
        <div ref={overlayRef} className="absolute left-0 top-0 origin-top-left" style={{ width: W, height: H }}>{world}</div>
      ) : (
        <div className="absolute left-1/2 top-1/2" style={{ width: W, height: H, marginLeft: -W / 2, marginTop: -H / 2 }}>{world}</div>
      )}
      <div className="absolute left-4 top-3.5 flex flex-wrap gap-3 rounded-md border border-line-soft bg-well/85 px-2.5 py-1.5 text-[11px] text-ink-muted">
        <span><b className="text-st-run">›</b> running</span><span><b className="text-st-run">✎</b> editing</span><span><b className="text-st-think">⋯</b> thinking</span>
        <span><b className="text-st-you">!</b> needs you</span><span><b className="text-st-blocked">⊘</b> blocked</span><span><b className="text-st-error">✕</b> error</span><span>- - - live link</span>
      </div>
      {ready && (
        <div data-map-control="" className="absolute bottom-3 right-4 flex cursor-default items-center gap-1 rounded-md border border-line-soft bg-well/85 p-1 text-[11px] text-ink-muted">
          <button type="button" aria-pressed={follow} onClick={() => setFollow((f) => !f)}
            className={cx('rounded-sm px-2 py-0.5 hover:text-ink', follow && 'bg-st-run/12 text-st-run hover:text-st-run')}>
            {follow ? '◉' : '○'} Follow activity
          </button>
          <span aria-hidden="true" className="h-3.5 w-px bg-line-soft" />
          <button type="button" onClick={() => { setFollow(false); fit() }} className="rounded-sm px-2 py-0.5 hover:text-ink">⤢ Reset view</button>
        </div>
      )}
    </section>
  )
}

function HqCard({ agent, x, y, questCount, className }: { agent: Agent; x: number; y: number; questCount: number; className?: string }) {
  const { dispatch } = useStore()
  const s = STATUS[agent.status]
  return (
    <button type="button" data-station={agent.id} onClick={() => dispatch({ type: 'inspect', id: agent.id })}
      className={cx('absolute w-[250px] rounded-2xl border-2 border-st-think bg-raised p-3.5 text-left shadow-raised', className)} style={{ left: x - 125, top: y - HQ_TOP }}>
      <div className="flex items-center gap-2.5">
        <span className="grid h-[34px] w-[34px] place-items-center bg-st-think font-display text-[10px] font-bold text-ground [clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)]">ORC</span>
        <div className="min-w-0 flex-1"><div className="whitespace-nowrap font-display text-[17px] font-bold leading-none">{agent.callsign}</div><div className="mt-1 text-[11px] text-ink-muted">Orchestrator · HQ</div></div>
        <span className="whitespace-nowrap rounded-xs border border-line-strong px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">{modelInfo(agent.model).short} {modelInfo(agent.model).pips}</span>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 text-xs font-semibold', s.badge)}>{s.glyph} {s.label}</span>
        <span className="text-[11px] text-ink-muted">{questCount} open quests</span>
      </div>
      <div className="mt-2 truncate text-[11px] text-ink-muted">{agent.currentAction}</div>
    </button>
  )
}

/** A worker station. `className` carries one-shot key-moment motion (animate-pop / animate-shake). */
export function StationCard({ agent, x, y, onOpen, selected, className }: { agent: Agent; x: number; y: number; onOpen: () => void; selected?: boolean; className?: string }) {
  const s = STATUS[agent.status]
  return (
    <button type="button" data-station={agent.id} onClick={onOpen} title={`${agent.callsign} · ${s.label} · ${(agent.tokensToday / 1000).toFixed(0)}k tokens · CPU ${agent.container.cpuPct}%`}
      className={cx('absolute w-[196px] rounded-lg border border-t-[3px] bg-surface px-3 py-2.5 text-left transition-transform duration-[160ms] hover:-translate-y-0.5',
        s.ring, agent.status === 'waiting' && 'animate-attention', agent.status === 'booting' && 'border-dashed', selected ? 'ring-2 ring-you' : 'border-x-line border-b-line', className)}
      style={{ left: x - STATION.left, top: y - STATION.top }}>
      <div className="flex items-center gap-2">
        <span className="grid h-[26px] w-[26px] place-items-center rounded-sm border border-line-strong bg-raised font-display text-[9px] font-bold text-ink-soft" style={{ backgroundImage: ROLES[agent.role].texture }}>{ROLES[agent.role].code}</span>
        <span className="flex-1 font-display text-[15px] font-semibold">{agent.callsign}</span>
        <span className="font-mono text-[10px] text-ink-muted">{modelInfo(agent.model).short} {modelInfo(agent.model).pips}</span>
      </div>
      <div className={cx('my-2 inline-flex items-center gap-1.5 rounded-full border px-2 text-xs font-semibold', s.badge)}>{s.glyph} {s.label}</div>
      <div className="truncate font-mono text-[11px] text-ink-soft">{agent.currentAction ?? '—'}</div>
      <div className="mt-2 flex items-center gap-1.5">
        <span className="flex-1"><Bar pct={agent.contextPct} className={agent.contextPct > 85 ? 'bg-st-error' : 'bg-ink-muted'} h="h-[3px]" /></span>
        <span className="font-mono text-[10px] text-ink-dim">ctx {agent.contextPct}%</span>
      </div>
    </button>
  )
}
