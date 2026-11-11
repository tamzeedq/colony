// App state with two data modes (docs/phase2.md "UI data modes"):
//   live (default)  data from the control plane: REST + one WebSocket stream, no mock data.
//   mock (?mock)    the design's seed data + a tiny simulation (?mock&static freezes it).
//
// ActivityEvents bypass React state: they go through `emit` to subscribers (feeds throttle them
// with useThrottledStream). `dispatch` applies an action locally (optimistic) and, in live mode,
// calls the matching API (store/live.ts); failures toast and trigger a resync from /api/snapshot.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import type { ActivityEvent, Guards, ID, Project, Snapshot, UiStreamMessage } from '@/types/colony'
import * as mock from '@/data/mock'
import { reducer, emptyUi, DEFAULT_GUARDS, EMPTY_RESOURCES, builtinModels, type Action, type State, type Toast } from './reducer'
import { liveEffect } from './live'
import { setModelRegistry } from '@/design/status'
import { connectStream, type StreamHandle, type StreamInfo } from '@/api/stream'
import { endpoints } from '@/api/endpoints'
import { ApiError, errorMessage } from '@/api/client'
import { getToken, onTokenChange, setToken } from '@/api/token'

export type { Action, State, Toast } from './reducer'
export type Mode = 'mock' | 'live'

type Listener = (e: ActivityEvent) => void

export interface Conn {
  token: string | null
  /** The last token was rejected (401) — the Pair screen says so. */
  rejected: boolean
  hydrated: boolean
  stream: StreamInfo
}

interface Ctx {
  state: State
  /** Resolves true when the action (and its API call, in live mode) succeeded. */
  dispatch: (a: Action) => Promise<boolean>
  subscribe: (fn: Listener) => () => void
  seedEvents: ActivityEvent[]
  mode: Mode
  conn: Conn
  pair: (token: string) => void
  retryNow: () => void
  resync: () => void
}

const StoreCtx = createContext<Ctx | null>(null)

const MAX_RECENT = 1000

function mockState(): State {
  return {
    projects: mock.projects, agents: mock.agents, quests: mock.quests, alerts: mock.alerts,
    resources: mock.resources, guards: mock.guards, mergeRequests: mock.mergeRequests, providers: mock.providers,
    models: builtinModels(), ui: emptyUi(),
  }
}

function liveState(): State {
  return {
    projects: [], agents: [], quests: [], alerts: [], resources: EMPTY_RESOURCES, guards: DEFAULT_GUARDS,
    mergeRequests: [], providers: [], models: builtinModels(), ui: emptyUi(),
  }
}

const toastAlert = (a: { id: ID; title: string; severity: string }): Toast =>
  ({ id: a.id, alertId: a.id, title: a.title, tone: a.severity === 'critical' ? 'critical' : 'needs_you', at: Date.now() })

export function StoreProvider({ children, mode = 'live', simulate = true }: { children: ReactNode; mode?: Mode; simulate?: boolean }) {
  const [state, rawDispatch] = useReducer(reducer, undefined, () => (mode === 'mock' ? mockState() : liveState()))
  const listeners = useRef(new Set<Listener>())
  const stateRef = useRef(state)
  stateRef.current = state
  const recent = useRef<ActivityEvent[]>(mode === 'mock' ? mock.events : [])

  const subscribe = useCallback((fn: Listener) => { listeners.current.add(fn); return () => { listeners.current.delete(fn) } }, [])
  const emit = useCallback((e: ActivityEvent) => listeners.current.forEach((fn) => fn(e)), [])

  // ── connection state (live) ──
  const [token, setTok] = useState<string | null>(() => (mode === 'live' ? getToken() : null))
  const [rejected, setRejected] = useState(false)
  const [hydrated, setHydrated] = useState(mode === 'mock')
  const [stream, setStream] = useState<StreamInfo>({ state: mode === 'mock' ? 'open' : 'connecting', attempt: 0 })
  const streamRef = useRef<StreamHandle | null>(null)
  const hydratedRef = useRef(false)

  const toastError = useCallback((title: string) =>
    rawDispatch({ type: 'toast', toast: { id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title, tone: 'error', at: Date.now() } }), [])

  const hydrate = useCallback((snap: Snapshot, guards?: Guards) => {
    setModelRegistry(snap.models)
    rawDispatch({ type: 'hydrate', snapshot: snap, guards })
  }, [])

  const resyncTimer = useRef<ReturnType<typeof setTimeout>>()
  const resync = useCallback(() => {
    if (mode !== 'live') return
    clearTimeout(resyncTimer.current)
    resyncTimer.current = setTimeout(() => {
      endpoints.snapshot().then((snap) => hydrate(snap, snap.guards), () => { /* stream will catch up */ })
    }, 400)
  }, [mode, hydrate])

  // ── dispatch: local first, then the API (live) ──
  const dispatch = useCallback(async (a: Action): Promise<boolean> => {
    const prev = stateRef.current
    if (mode === 'live' && a.type === 'downshift') {
      // Live: only the model changes; usage comes from the control plane.
      prev.agents.filter((x) => x.role !== 'orchestrator' && x.status !== 'waiting').forEach((x) => rawDispatch({ type: 'setModel', id: x.id, model: 'haiku-5.5' }))
    } else {
      rawDispatch(a)
    }
    if (mode !== 'live') return true
    const eff = liveEffect(a, prev)
    if (!eff) return true
    try {
      const result = await eff.run()
      eff.then?.(result).forEach(rawDispatch)
      return true
    } catch (e) {
      eff.undo?.().forEach(rawDispatch)
      if (e instanceof ApiError && e.status === 401) return false // back to Pair
      toastError(`${eff.label} failed · ${errorMessage(e)}`)
      resync()
      return false
    }
  }, [mode, toastError, resync])

  // ── mock: live simulation, usage creeping up ──
  useEffect(() => {
    if (mode !== 'mock' || !simulate) return
    let n = 0
    const tick = setInterval(() => {
      const s = stateRef.current
      const live = s.agents.filter((x) => ['running', 'editing', 'thinking'].includes(x.status))
      if (!live.length) return
      const ag = live[Math.floor(Math.random() * live.length)]
      const lines = mock.SIM_LINES[ag.role] ?? mock.SIM_LINES.custom
      const l = lines[Math.floor(Math.random() * lines.length)]
      const e: ActivityEvent = { id: `sim-${Date.now()}-${n++}`, at: new Date().toISOString(), agentId: ag.id, projectId: ag.projectId, kind: l.kind, text: l.text }
      if (l.kind === 'command') {
        e.command = { cmd: l.text, running: Math.random() < 0.4, exitCode: 0, durationMs: 2000 + Math.random() * 9000 }
        rawDispatch({ type: 'agentStatus', id: ag.id, status: 'running', action: l.text })
      }
      if (l.kind === 'edit') rawDispatch({ type: 'agentStatus', id: ag.id, status: 'editing', action: l.text.split(' ')[0] })
      emit(e)
    }, 450)
    const usage = setInterval(() => rawDispatch({ type: 'usageTick' }), 5000)
    return () => { clearInterval(tick); clearInterval(usage) }
  }, [mode, simulate, emit])

  // ── mock: booting agents come online after a few seconds (live: the stream does this) ──
  useEffect(() => {
    if (mode !== 'mock') return
    const booting = state.agents.filter((a) => a.status === 'booting')
    if (!booting.length) return
    const t = setTimeout(() => booting.forEach((a) => {
      rawDispatch({ type: 'agentStatus', id: a.id, status: 'idle', action: 'Online · waiting for a quest' })
      rawDispatch({ type: 'toast', toast: { id: `joined-${a.id}`, title: `${a.callsign} joined and is ready`, tone: 'done', at: Date.now() } })
    }), 3500)
    return () => clearTimeout(t)
  }, [mode, state.agents])

  // ── live: token ──
  useEffect(() => {
    if (mode !== 'live') return
    return onTokenChange((t) => {
      setTok((prev) => { if (prev && !t) setRejected(true); if (t) setRejected(false); return t })
      if (!t) { hydratedRef.current = false; setHydrated(false) }
    })
  }, [mode])

  // ── live: the stream ──
  useEffect(() => {
    if (mode !== 'live' || !token) return
    const seenUnresolved = new Set<ID>()

    const onMessage = (msg: UiStreamMessage, raw: Record<string, unknown>) => {
      switch (msg.type) {
        case 'snapshot': {
          const snap = msg.snapshot
          const rawGuards = (raw.snapshot as { guards?: Guards } | undefined)?.guards
          const first = !hydratedRef.current
          // Toast alerts that appeared while we were disconnected; never the initial backlog.
          for (const al of snap.alerts) {
            if (al.resolvedAt) { seenUnresolved.delete(al.id); continue }
            if (!first && !seenUnresolved.has(al.id) && al.severity !== 'heads_up') rawDispatch({ type: 'toast', toast: toastAlert(al) })
            seenUnresolved.add(al.id)
          }
          hydrate(snap, rawGuards)
          const events = snap.events ?? []
          recent.current = events.slice(-MAX_RECENT)
          if (!first) events.forEach(emit) // feeds already mounted upsert by id
          if (first && !rawGuards) endpoints.getGuards().then((g) => g && rawDispatch({ type: 'setGuards', guards: g }), () => { /* older control plane */ })
          hydratedRef.current = true
          setHydrated(true)
          break
        }
        case 'agent_delta': {
          const prev = stateRef.current.agents.find((x) => x.id === msg.agentId)
          const next = msg.patch.status
          if (prev?.status === 'booting' && next && next !== 'booting' && next !== 'error') {
            rawDispatch({ type: 'toast', toast: { id: `joined-${prev.id}`, title: `${msg.patch.callsign ?? prev.callsign} joined and is ready`, tone: 'done', at: Date.now() } })
          }
          rawDispatch({ type: 'patchAgent', id: msg.agentId, patch: msg.patch })
          break
        }
        case 'event': {
          const e = msg.event
          const r = recent.current
          const i = r.findIndex((x) => x.id === e.id)
          if (i >= 0) r[i] = e
          else { r.push(e); if (r.length > MAX_RECENT) r.splice(0, r.length - MAX_RECENT) }
          emit(e)
          break
        }
        case 'alert': {
          const al = msg.alert
          if (al.resolvedAt) seenUnresolved.delete(al.id)
          else if (!seenUnresolved.has(al.id)) {
            seenUnresolved.add(al.id)
            if (al.severity === 'critical' || al.severity === 'needs_you') rawDispatch({ type: 'toast', toast: toastAlert(al) })
          }
          rawDispatch({ type: 'upsertAlert', alert: al })
          break
        }
        case 'resources': rawDispatch({ type: 'resources', resources: msg.resources }); break
      }
    }

    const h = connectStream({ token, onMessage, onInfo: setStream })
    streamRef.current = h
    return () => { h.close(); if (streamRef.current === h) streamRef.current = null }
  }, [mode, token, emit, hydrate])

  const pair = useCallback((t: string) => setToken(t), [])
  const retryNow = useCallback(() => streamRef.current?.retryNow(), [])

  const conn: Conn = useMemo(() => ({ token, rejected, hydrated, stream }), [token, rejected, hydrated, stream])

  const value = useMemo<Ctx>(() => ({
    state, dispatch, subscribe, mode, conn, pair, retryNow, resync,
    // Read at mount by feeds: the latest backlog, not the one from the last render.
    get seedEvents() { return recent.current },
  }), [state, dispatch, subscribe, mode, conn, pair, retryNow, resync])
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}

export function useStore() {
  const c = useContext(StoreCtx)
  if (!c) throw new Error('useStore must be used inside <StoreProvider>')
  return c
}

/* ---------- selectors ---------- */
export const needsYou = (s: State) => s.alerts.filter((a) => !a.resolvedAt && a.severity !== 'heads_up')
export const agentById = (s: State, id?: ID) => s.agents.find((a) => a.id === id)
export const projectByKey = (s: State, key: number) => s.projects.find((p) => p.key === key)
export const projectAgents = (s: State, p: Project) => s.agents.filter((a) => a.projectId === p.id)
export const projectQuests = (s: State, p: Project) => s.quests.filter((q) => q.projectId === p.id)
export const sessionShare = (s: State, p: Project) => projectAgents(s, p).reduce((n, a) => n + a.sessionShare, 0)
/** Merge request for an approval alert: `al-<mrId>` (projects.ts), else the pending one for that agent/project. */
export const mergeRequestForAlert = (s: State, alert: { id: ID; projectId?: ID; agentId?: ID }) =>
  s.mergeRequests.find((m) => `al-${m.id}` === alert.id)
  ?? s.mergeRequests.find((m) => m.status === 'pending' && m.projectId === alert.projectId && (!alert.agentId || m.requestedBy === alert.agentId))
