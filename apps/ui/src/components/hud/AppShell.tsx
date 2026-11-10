import { NavLink, Outlet, Link } from 'react-router-dom'
import { useStore, needsYou } from '@/store/store'
import { Meter } from '@/components/ui/primitives'
import { Inspector } from '@/components/agent/Inspector'
import { ToastStack, CriticalBanner } from '@/components/alerts/Toasts'
import { ShortcutOverlay, CommandPalette } from '@/components/states/Overlays'
import { useHotkeys } from '@/hooks/useHotkeys'
import { useMediaQuery, ULTRAWIDE } from '@/hooks/useMediaQuery'
import { cx, untilLabel, usd } from '@/lib/util'

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5 text-ink no-underline">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-you)" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z" /><circle cx="12" cy="12" r="2.6" />
      </svg>
      <span className="font-display text-[15px] font-bold tracking-[.16em]">COLONY</span>
    </Link>
  )
}

export function NeedsYouCounter() {
  const { state } = useStore()
  const n = needsYou(state).length
  if (!n) return <span className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-dim">◇ All clear</span>
  return (
    <Link to="/inbox" className="flex items-center gap-2.5 rounded-md border border-st-you/45 bg-st-you/12 py-1.5 pl-2.5 pr-3 text-[13px] font-semibold text-st-you no-underline">
      <span aria-hidden="true" className="block h-3 w-3 rotate-45 animate-attention bg-st-you" />
      {n} need you
    </Link>
  )
}

export function ResourceHud() {
  const { state } = useStore()
  const r = state.resources
  const g = state.guards
  return (
    <>
      <Meter label="Session limit" pct={r.usage.session.usedPct} value={`${Math.round(r.usage.session.usedPct)}%`} sub={`resets ${untilLabel(r.usage.session.resetsAt)}`} warn={g.warnAtPct} critical={g.pauseWorkersAtPct} />
      <Meter label="Weekly limit" pct={r.usage.weekly.usedPct} value={`${Math.round(r.usage.weekly.usedPct)}%`} sub="resets Thu" warn={g.weeklyWarnAtPct} />
      <Meter label="Spend today" pct={(r.spendTodayUsd / r.dailyCapUsd) * 100} value={usd(r.spendTodayUsd)} sub={`/ ${usd(r.dailyCapUsd).replace('.00', '')}`} neutral />
      <span className="hidden 2xl:contents">
        <Meter label="Containers" pct={(r.containers.running / r.containers.max) * 100} value={r.containers.running} sub={`/ ${r.containers.max}`} neutral />
        <Meter label="Host" pct={r.host.cpuPct} value={`${r.host.cpuPct}%`} sub={`CPU · ${Math.round((r.host.memUsedGb / r.host.memTotalGb) * 100)}% RAM`} neutral />
      </span>
    </>
  )
}

const NAV = [
  { to: '/', label: 'World', end: true }, { to: '/base/1', label: 'Bases' }, { to: '/roster', label: 'Roster' },
  { to: '/inbox', label: 'Inbox' }, { to: '/settings/limits', label: 'Settings' },
]

export function AppShell() {
  useHotkeys()
  const { state, dispatch } = useStore()
  const ultra = useMediaQuery(ULTRAWIDE)
  const docked = ultra && !!state.ui.inspectAgentId
  return (
    <div className="flex min-h-screen flex-col bg-ground text-ink">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line-soft bg-hud px-5 py-2.5">
        <Logo />
        <nav aria-label="Primary" className="flex flex-wrap gap-0.5">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => cx('rounded-sm px-3 py-1.5 text-[13px] no-underline',
                isActive || (n.label === 'Bases' && location.pathname.startsWith('/base')) ? 'bg-ink font-semibold text-ground' : 'font-medium text-ink-muted hover:text-ink')}>
              {n.label}{n.label === 'Inbox' && needsYou(state).length ? ` · ${needsYou(state).length}` : ''}
            </NavLink>
          ))}
        </nav>
        <div className="flex-1" />
        <ResourceHud />
        <NeedsYouCounter />
        <button type="button" onClick={() => dispatch({ type: 'pauseAll' })} className="rounded-md border border-line bg-raised px-3 py-1.5 text-[13px]">‖ Pause all</button>
        <button type="button" aria-label="Keyboard shortcuts" onClick={() => dispatch({ type: 'overlay', overlay: 'shortcuts' })}
          className="h-8 w-8 rounded-md border border-line font-mono text-[13px] text-ink-muted">?</button>
      </header>
      <CriticalBanner />
      <div className={cx('flex-1', docked && 'pr-[820px]')}>
        <Outlet />
      </div>
      <Inspector docked={ultra} />
      <ToastStack />
      <ShortcutOverlay />
      <CommandPalette />
    </div>
  )
}
