import { NavLink, Navigate, useParams } from 'react-router-dom'
import { cx } from '@/lib/util'
import { SpendUsage } from './SpendUsage'
import { GithubSettings } from './GithubSettings'
import { SecuritySettings } from './SecuritySettings'
import { Limits } from './settings/Limits'
import { AlertsSection } from './settings/Alerts'
import { Providers } from './settings/Providers'
import { Docker } from './settings/DockerHost'
import { Teams } from './settings/Teams'
import { Roles } from './settings/Roles'
import { Keys } from './settings/Keys'
import { Housekeeping } from './settings/Housekeeping'

const SECTIONS = [
  { id: 'limits', g: '◷', label: 'Limits & budgets' }, { id: 'spend', g: '▤', label: 'Spend & usage' },
  { id: 'alerts', g: '♪', label: 'Alerts & sound' }, { id: 'housekeeping', g: '▣', label: 'Housekeeping' },
  { id: 'providers', g: '◈', label: 'Providers & keys' }, { id: 'github', g: '⑂', label: 'GitHub' }, { id: 'security', g: '⛨', label: 'Security' },
  { id: 'docker', g: '▣', label: 'Docker & host' }, { id: 'teams', g: '⬡', label: 'Team templates' },
  { id: 'roles', g: '☰', label: 'Role library' }, { id: 'keys', g: '⌨', label: 'Keyboard' },
]

export function Settings() {
  const { section = 'limits' } = useParams()
  if (!SECTIONS.some((s) => s.id === section)) return <Navigate to="/settings/limits" replace />
  return (
    <div className="flex flex-wrap">
      <nav aria-label="Settings sections" className="flex min-w-0 max-w-[280px] flex-[1_1_240px] flex-col gap-0.5 border-r border-line-soft bg-well px-3.5 py-5.5">
        <div className="px-2.5 pb-3.5 font-display text-[22px] font-semibold">Settings</div>
        {SECTIONS.map((s) => (
          <NavLink key={s.id} to={`/settings/${s.id}`} className={({ isActive }) => cx('flex items-center gap-2.5 rounded-md px-2.5 py-2 no-underline', isActive ? 'bg-raised font-semibold text-ink' : 'text-ink-muted hover:text-ink')}>
            {({ isActive }) => <><span className={cx('w-[18px] font-mono', isActive ? 'text-you' : 'text-ink-dim')}>{s.g}</span>{s.label}</>}
          </NavLink>
        ))}
        <div className="mt-auto px-2.5 py-3 text-xs leading-normal text-ink-dim">Settings file<br /><span className="font-mono text-ink-muted">~/.colony/config.toml</span></div>
      </nav>
      <main className="flex min-w-0 max-w-[1040px] flex-[999_1_720px] flex-col gap-5.5 px-8.5 pb-10 pt-6.5">
        {section === 'limits' && <Limits />}
        {section === 'spend' && <SpendUsage />}
        {section === 'alerts' && <AlertsSection />}
        {section === 'housekeeping' && <Housekeeping />}
        {section === 'providers' && <Providers />}
        {section === 'github' && <GithubSettings />}
        {section === 'security' && <SecuritySettings />}
        {section === 'docker' && <Docker />}
        {section === 'teams' && <Teams />}
        {section === 'roles' && <Roles />}
        {section === 'keys' && <Keys />}
      </main>
    </div>
  )
}
