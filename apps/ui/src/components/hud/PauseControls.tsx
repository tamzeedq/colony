// Pause all / Pause base toggle, the "N paused" chip, the progress / undo bar, and Shut down Colony.
// Logic lives in store/pauseControls.ts (feedback #18).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from '@/store/store'
import {
  bindPause, cancelCountdown, closeShutdown, dismissOp, openShutdown, opSummary, pauseView, pausedGroups, REASON_LABEL,
  requestPause, resumeAgents, resumeScope, runShutdown, trackPause, undoPause, usePauseUi, COUNTDOWN_MS, type PauseScope,
} from '@/store/pauseControls'
import { ROLES } from '@/design/status'
import { cx } from '@/lib/util'

const EXPLAIN = 'Agents stop after their current step (orchestrators included, unless you pause workers only). Containers keep running, nothing is lost, and Resume continues where each agent left off.'

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, close])
  return ref
}

function Popover({ children, width = 'w-[22rem]' }: { children: ReactNode; width?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(false)
  // Hang from the trigger's right edge, unless that would run off the left of the window.
  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.parentElement
    if (el && parent) setLeft(parent.getBoundingClientRect().right - el.offsetWidth < 8)
  }, [])
  return <div ref={ref} className={cx('absolute top-full z-50 mt-1.5 max-h-[70vh] overflow-y-auto rounded-lg border border-line-strong bg-surface p-3 text-[13px] shadow-raised', width, left ? 'left-0' : 'right-0')}>{children}</div>
}

/** HUD "Pause all" (scope all) and the Base page's "Pause base": a toggle with a menu for the details. */
export function PauseToggle({ scope, kbd, size = 'hud' }: { scope: PauseScope; kbd?: string; size?: 'hud' | 'base' }) {
  const { state } = useStore()
  const { op } = usePauseUi()
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const v = pauseView(state, scope, op)
  const noun = scope.kind === 'all' ? 'all' : 'base'
  const label = v.progress ? `Pausing… ${v.progress.done} of ${v.progress.total}`
    : v.mode === 'resume' ? `▸ Resume ${noun}`
    : v.mode === 'limits-only' ? `All paused by limits`
    : v.mode === 'none' ? `‖ Pause ${noun}`
    : v.paused + v.pausing > 0 ? `‖ Pause ${noun} · ${v.running} running` : `‖ Pause ${noun}`
  const onMain = () => {
    if (v.mode === 'resume') resumeScope(scope)
    else if (v.mode === 'limits-only') setOpen(true)
    else if (v.mode === 'pause') requestPause(scope)
  }
  const base = scope.kind === 'base'
  return (
    <div ref={ref} className="relative flex">
      <button type="button" onClick={onMain} disabled={v.mode === 'none'} title={EXPLAIN}
        className={cx('border border-line bg-raised text-[13px] disabled:opacity-50', size === 'hud' ? 'rounded-l-md px-3 py-1.5' : 'min-h-9 rounded-l-md px-3.5', v.progress && 'animate-breathe text-st-paused')}>
        {label}{kbd && <span className="ml-2 rounded-xs border border-current/35 px-1 font-mono text-[11px] opacity-70">{kbd}</span>}
      </button>
      <button type="button" aria-label={`${noun === 'all' ? 'Pause' : 'Base pause'} options`} aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={cx('rounded-r-md border border-l-0 border-line bg-raised px-2 text-[11px] text-ink-muted', size === 'hud' ? 'py-1.5' : 'min-h-9')}>▾</button>
      {open && (
        <Popover>
          <p className="m-0 mb-2.5 leading-snug text-ink-soft">{EXPLAIN}</p>
          <div className="flex flex-col gap-1.5">
            {v.mode === 'pause' && v.running > 0 && (
              <button type="button" onClick={() => { setOpen(false); requestPause(scope, true) }} className="rounded-md border border-line px-3 py-2 text-left hover:bg-raised">
                ‖ Pause workers only <span className="block text-xs text-ink-dim">Orchestrators keep running and can still plan.</span>
              </button>
            )}
            {(v.mode === 'pause' || v.mode === 'resume' || v.mode === 'limits-only') && v.pausedByYou > 0 && v.mode !== 'resume' && (
              <button type="button" onClick={() => { setOpen(false); resumeScope(scope) }} className="rounded-md border border-line px-3 py-2 text-left hover:bg-raised">
                ▸ Resume the {v.pausedByYou} you paused
              </button>
            )}
            {v.pausedByLimits > 0 && (
              <button type="button" onClick={() => { setOpen(false); resumeScope(scope, true) }} className="rounded-md border border-line px-3 py-2 text-left hover:bg-raised">
                ▸ Resume {noun}, including {v.pausedByLimits} paused by limits
                <span className="block text-xs text-ink-dim">A budget or plan guard may pause them again.</span>
              </button>
            )}
            {v.mode === 'none' && <span className="text-ink-dim">No live agents{base ? ' in this base' : ''}.</span>}
          </div>
        </Popover>
      )}
    </div>
  )
}

/** "‖ N paused": who is paused and why, each with Resume. Hidden when nothing is paused. */
export function PausedChip() {
  const { state } = useStore()
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const groups = pausedGroups(state)
  const n = groups.reduce((s, g) => s + g.agents.length, 0)
  useEffect(() => { if (!n) setOpen(false) }, [n])
  if (!n) return null
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-st-paused/45 bg-st-paused/12 px-3 py-1.5 text-[13px] font-semibold text-st-paused">‖ {n} paused</button>
      {open && (
        <Popover>
          {groups.map((g) => (
            <section key={g.reason} className="mb-2.5 last:mb-0">
              <div className="mb-1 flex items-center text-[11px] font-semibold uppercase tracking-[.1em] text-ink-dim">
                <span className="flex-1">{REASON_LABEL[g.reason]}</span>
                {g.agents.length > 1 && <button type="button" onClick={() => resumeAgents(g.agents.map((a) => a.id))} className="normal-case tracking-normal text-you">Resume {g.agents.length}</button>}
              </div>
              {g.agents.map((a) => (
                <div key={a.id} className="flex items-center gap-2 border-b border-line-soft py-1.5 last:border-0">
                  <span className="min-w-0 flex-1"><b className="font-display font-semibold">{a.callsign}</b> <span className="text-xs text-ink-dim">{ROLES[a.role].name}</span></span>
                  <button type="button" onClick={() => resumeAgents([a.id])} className="rounded-sm border border-line-strong px-2.5 py-1 text-xs">▸ Resume</button>
                </div>
              ))}
              {g.reason !== 'you' && <p className="m-0 mt-1 text-[11px] text-ink-dim">Resuming now may pause again if the limit is still hit.</p>}
            </section>
          ))}
        </Popover>
      )}
    </div>
  )
}

/** Mounted once in the shell: keeps the controller bound to the latest state and finishes pauses in flight. */
export function PauseEffects() {
  const { state, dispatch, mode } = useStore()
  const { op } = usePauseUi()
  bindPause({ state, dispatch, mode })
  useEffect(() => { trackPause(state) }, [state.agents, op?.seq, op?.phase]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (op?.phase !== 'pausing') return
    const t = setInterval(() => trackPause(state), 1000)
    return () => clearInterval(t)
  }, [op?.seq, op?.phase, state])
  // The done / partial bar fades out on its own.
  useEffect(() => {
    if (!op || op.phase === 'pausing') return
    const t = setTimeout(dismissOp, op.phase === 'partial' ? 20_000 : 12_000)
    return () => clearTimeout(t)
  }, [op?.seq, op?.phase]) // eslint-disable-line react-hooks/exhaustive-deps
  // Mock mode has no runners: agents report paused a moment after the request.
  const sim = useRef(new Set<string>())
  useEffect(() => {
    if (mode !== 'mock') return
    for (const a of state.agents) {
      if (!a.pauseRequested || a.status === 'paused' || sim.current.has(a.id)) continue
      sim.current.add(a.id)
      setTimeout(() => { sim.current.delete(a.id); void dispatch({ type: 'agentStatus', id: a.id, status: 'paused', action: 'Paused by you' }) }, 700 + Math.random() * 2600)
    }
  }, [mode, state.agents, dispatch])
  return null
}

/** Countdown / progress / undo, bottom centre. */
export function PauseBar() {
  const { state } = useStore()
  const { countdown, op } = usePauseUi()
  const [, tick] = useState(0)
  useEffect(() => {
    if (!countdown && op?.phase !== 'pausing') return
    const t = setInterval(() => tick((n) => n + 1), 200)
    return () => clearInterval(t)
  }, [countdown, op?.phase])
  if (!countdown && !op) return null
  const cls = 'fixed bottom-5 left-1/2 z-[60] flex max-w-[min(680px,92vw)] -translate-x-1/2 items-center gap-3 rounded-lg border border-line-strong bg-raised px-4 py-2.5 text-[13px] shadow-raised'
  if (countdown) {
    const left = Math.max(1, Math.ceil((countdown.endsAt - Date.now()) / 1000))
    const where = countdown.scope.kind === 'base' ? ` in ${countdown.scope.name}` : ''
    return (
      <div role="status" className={cls}>
        <span className="font-mono text-st-paused">‖</span>
        <span>Pausing{where}{countdown.workersOnly ? ' (workers only)' : ''} in {left}… agents are mid-task and will stop after their current step.</span>
        <button type="button" onClick={() => requestPause(countdown.scope, countdown.workersOnly)} className="rounded-sm border border-line-strong px-2.5 py-1 text-xs">Pause now</button>
        <button type="button" onClick={cancelCountdown} className="rounded-sm bg-you px-2.5 py-1 text-xs font-semibold text-you-ink">Cancel</button>
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden rounded-b-lg bg-line"><span className="block h-full bg-st-paused" style={{ width: `${Math.max(0, ((countdown.endsAt - Date.now()) / COUNTDOWN_MS) * 100)}%` }} /></span>
      </div>
    )
  }
  if (!op) return null
  return (
    <div role="status" className={cls}>
      <span className={cx('font-mono', op.phase === 'partial' ? 'text-st-blocked' : 'text-st-paused')}>{op.phase === 'pausing' ? '…' : '‖'}</span>
      <span>{opSummary(state, op)}</span>
      {op.phase === 'pausing' && <span className="text-xs text-ink-dim">Finishing the current step</span>}
      {op.phase !== 'pausing' && <button type="button" onClick={undoPause} className="rounded-sm bg-you px-2.5 py-1 text-xs font-semibold text-you-ink">Undo</button>}
      {op.phase === 'pausing' && <button type="button" onClick={undoPause} className="rounded-sm border border-line-strong px-2.5 py-1 text-xs">Cancel</button>}
      <button type="button" aria-label="Dismiss" onClick={dismissOp} className="text-ink-dim">✕</button>
    </div>
  )
}

/** HUD button + confirm dialog + the "shut down" screen. */
export function ShutdownButton() {
  return (
    <button type="button" aria-label="Shut down Colony" title="Shut down Colony…" onClick={openShutdown}
      className="h-8 w-8 rounded-md border border-line text-[14px] text-ink-muted hover:text-st-error">⏻</button>
  )
}

export function ShutdownDialog() {
  const { shutdown, shutdownSteps, shutdownError } = usePauseUi()
  const { state } = useStore()
  if (!shutdown) return null
  if (shutdown === 'done') {
    return (
      <div role="alertdialog" aria-label="Colony is shut down" className="fixed inset-0 z-[100] grid place-items-center bg-ground p-6 text-center">
        <div className="max-w-md">
          <div className="mb-3 font-mono text-4xl text-ink-dim">⏻</div>
          <h1 className="m-0 mb-2 font-display text-2xl font-semibold">Colony is shut down</h1>
          <p className="m-0 mb-3 text-ink-soft">Run <code className="rounded-xs border border-line px-1.5 py-0.5 font-mono text-[13px]">npm start</code> to start it again. Agents resume where they left off.</p>
          <p className="m-0 text-xs text-ink-dim">Agent containers were left as they are. Use <code className="font-mono">npm run stop</code> from the terminal next time to stop those as well.</p>
        </div>
      </div>
    )
  }
  const stacks = state.projects.filter((p) => p.supabase.status === 'running' || p.supabase.status === 'provisioning')
  const live = state.agents.filter((a) => a.status !== 'error' && a.status !== 'done').length
  return (
    <div className="fixed inset-0 z-[90] grid place-items-start justify-center bg-[rgb(5_7_10/.62)] pt-[14vh]" onClick={shutdown === 'working' ? undefined : closeShutdown}>
      <div role="dialog" aria-label="Shut down Colony" onClick={(e) => e.stopPropagation()} className="w-[min(520px,92vw)] animate-pop rounded-2xl border border-line-strong bg-surface p-5 shadow-raised">
        <h2 className="m-0 mb-2 font-display text-xl font-semibold">Shut down Colony?</h2>
        <ol className="m-0 mb-3 list-decimal space-y-1 pl-5 text-[13px] text-ink-soft">
          <li>Pauses all {live} live agent{live === 1 ? '' : 's'} (they finish their current step).</li>
          <li>Stops the dev Supabase stack{stacks.length === 1 ? '' : 's'}{stacks.length ? ` of ${stacks.map((p) => p.name).join(', ')}` : ' (none running)'}.</li>
          <li>Stops the control plane and this Ops Deck connection.</li>
        </ol>
        <p className="m-0 mb-4 text-xs text-ink-dim">Agent and git containers are left as they are from here (<code className="font-mono">npm run stop</code> in the terminal stops those too). Nothing is lost: <code className="font-mono">npm start</code> brings Colony back and agents resume.</p>
        {shutdown !== 'confirm' && (
          <ul className="m-0 mb-3 list-none space-y-0.5 p-0 text-[13px]">
            {shutdownSteps.map((s, i) => <li key={s} className={i === shutdownSteps.length - 1 && shutdown === 'working' ? 'text-ink' : 'text-ink-dim'}>{i === shutdownSteps.length - 1 && shutdown === 'working' ? '…' : '✓'} {s}</li>)}
            {shutdownError && <li className="text-st-error">✕ {shutdownError}</li>}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={shutdown === 'working'} onClick={closeShutdown} className="min-h-9 rounded-md border border-line px-3.5 text-[13px] disabled:opacity-50">Cancel</button>
          <button type="button" disabled={shutdown === 'working'} onClick={() => void runShutdown()} className="min-h-9 rounded-md border border-st-error/60 bg-st-error/12 px-3.5 text-[13px] font-semibold text-st-error disabled:opacity-50">
            {shutdown === 'working' ? 'Shutting down…' : shutdown === 'error' ? 'Try again' : 'Shut down'}
          </button>
        </div>
      </div>
    </div>
  )
}
