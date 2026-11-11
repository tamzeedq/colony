// Base → Infra: the project's dev Supabase stack (docs/phase4.md "UI").
// Mock mode is read-only. Live mode adds Provision/Start/Stop, the Studio toggle and Reset (behind a
// confirm), and lists applied migrations while the stack runs. start/stop/reset answer 202; the
// final status arrives with the next snapshot, and we poll the details route while provisioning.
import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/store/store'
import { endpoints, type SupabaseAction } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { Switch } from '@/components/ui/controls'
import { cx } from '@/lib/util'
import type { Project, SupabaseInfo, SupabaseMigration } from '@/types/colony'

const MAX_MIGRATIONS = 6
const POLL_MS = 4000
const STATUSES: SupabaseInfo['status'][] = ['running', 'stopped', 'provisioning', 'error', 'none']

const STATUS_VIEW: Record<SupabaseInfo['status'], { label: string; cls: string }> = {
  running: { label: '● Running', cls: 'text-st-done' },
  stopped: { label: '‖ Stopped', cls: 'text-st-paused' },
  provisioning: { label: '◌ Provisioning…', cls: 'text-st-run' },
  error: { label: '✕ Error', cls: 'text-st-error' },
  none: { label: '○ Not provisioned', cls: 'text-ink-dim' },
}

/** Pull SupabaseInfo fields out of a response (bare, `{ supabase }`, or a whole Project). */
function infoFrom(r: unknown): Partial<SupabaseInfo> | undefined {
  const o = r as ({ supabase?: Partial<SupabaseInfo> } & Partial<SupabaseInfo>) | undefined
  if (o?.supabase && typeof o.supabase === 'object' && STATUSES.includes(o.supabase.status!)) return o.supabase
  if (o && STATUSES.includes(o.status!)) {
    const { migrations: _m, ...info } = o as Partial<SupabaseInfo> & { migrations?: unknown }
    return info
  }
  return undefined
}

export function SupabasePanel({ project }: { project: Project }) {
  const { mode, dispatch } = useStore()
  const live = mode === 'live'
  const sb = project.supabase
  const [migrations, setMigrations] = useState<SupabaseMigration[] | null>(null)
  const [busy, setBusy] = useState<'' | SupabaseAction | 'studio'>('')
  const [error, setError] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)

  // Latest project, so async merges never write back a stale copy.
  const latest = useRef(project)
  latest.current = project
  const merge = (patch: Partial<SupabaseInfo>) => {
    const p = latest.current
    dispatch({ type: 'upsertProject', project: { ...p, supabase: { ...p.supabase, ...patch } } })
  }

  // Migrations: only while running; refetch when the status or latest migration changes.
  useEffect(() => {
    if (!live || sb.status !== 'running') { setMigrations(null); return }
    let on = true
    endpoints.supabaseDetails(project.id).then((d) => { if (on) setMigrations(d?.migrations ?? []) }, () => { if (on) setMigrations(null) })
    return () => { on = false }
  }, [live, project.id, sb.status, sb.migration])

  // While provisioning, poll so the panel settles even if no snapshot arrives.
  useEffect(() => {
    if (!live || sb.status !== 'provisioning') return
    const t = setInterval(() => {
      endpoints.supabaseDetails(project.id).then((d) => {
        const info = infoFrom(d)
        if (info && info.status !== 'provisioning') merge(info)
      }, () => { /* the snapshot will catch up */ })
    }, POLL_MS)
    return () => clearInterval(t)
  }, [live, project.id, sb.status])

  const run = async (action: SupabaseAction) => {
    setBusy(action); setError(''); setConfirmReset(false)
    try {
      const r = await endpoints.supabaseAction(project.id, action)
      merge(infoFrom(r) ?? (action === 'stop' ? {} : { status: 'provisioning', error: undefined }))
    } catch (e) {
      setError(`${action === 'start' ? (sb.status === 'none' ? 'Provision' : 'Start') : action === 'stop' ? 'Stop' : 'Reset'} failed · ${errorMessage(e)}`)
    } finally {
      setBusy('')
    }
  }

  const toggleStudio = async (studio: boolean) => {
    setBusy('studio'); setError('')
    try {
      const r = await endpoints.setSupabaseStudio(project.id, studio)
      merge({ studio, ...infoFrom(r) })
    } catch (e) {
      setError(`Studio ${studio ? 'on' : 'off'} failed · ${errorMessage(e)}`)
    } finally {
      setBusy('')
    }
  }

  const view = STATUS_VIEW[sb.status] ?? STATUS_VIEW.none
  const provisioning = sb.status === 'provisioning'
  const locked = provisioning || !!busy
  const shown = migrations ? [...migrations].sort((a, b) => b.version.localeCompare(a.version)) : []

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-semibold">Supabase (dev)</span>
        <span className={cx('flex items-center gap-1.5 text-[11px] font-semibold', view.cls)}>
          {provisioning ? <><span aria-hidden="true" className="h-[7px] w-[7px] animate-breathe rounded-full bg-st-run" />Provisioning…</> : view.label}
        </span>
        {sb.studioUrl && <a href={sb.studioUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs font-semibold text-ink no-underline hover:underline">Open Studio ↗</a>}
      </div>

      {sb.status === 'error' && sb.error && <pre className="m-0 mb-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-st-error">{sb.error}</pre>}
      {provisioning && live && <div className="mb-1.5 text-xs text-ink-dim">Starting the stack. A first run pulls images and can take a few minutes.</div>}

      {sb.url && <UrlRow label="API" value={sb.url} copyable={live} />}
      {sb.dbUrl && <UrlRow label="psql" value={sb.dbUrl} copyable={live} />}

      {live && sb.status === 'running' && (
        <div className="mt-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[.1em] text-ink-dim">Migrations</div>
          {migrations === null
            ? <div className="text-xs text-ink-dim">Loading…</div>
            : shown.length === 0
              ? <div className="text-xs text-ink-dim">None applied yet</div>
              : <>
                  {shown.slice(0, MAX_MIGRATIONS).map((m) => (
                    <div key={m.version} className="flex gap-2 py-0.5 text-xs">
                      <span className="shrink-0 font-mono text-ink-dim">{m.version}</span>
                      <span className="min-w-0 flex-1 truncate text-ink-soft">{m.name}</span>
                    </div>
                  ))}
                  {shown.length > MAX_MIGRATIONS && <div className="pt-0.5 text-xs text-ink-dim">+{shown.length - MAX_MIGRATIONS} more</div>}
                </>}
        </div>
      )}
      {!live && sb.migration && <div className="mt-1.5 text-xs text-ink-dim">migration {sb.migration}</div>}

      {live && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2.5">
          {sb.status === 'none' && <SmallBtn disabled={locked} onClick={() => void run('start')}>{busy === 'start' ? 'Provisioning…' : '⬢ Provision'}</SmallBtn>}
          {(sb.status === 'stopped' || sb.status === 'error') && <SmallBtn disabled={locked} onClick={() => void run('start')}>{busy === 'start' ? 'Starting…' : '▸ Start'}</SmallBtn>}
          {sb.status === 'running' && <SmallBtn disabled={locked} onClick={() => void run('stop')}>{busy === 'stop' ? 'Stopping…' : '‖ Stop'}</SmallBtn>}
          {sb.status !== 'none' && (
            <label className={cx('flex items-center gap-1.5 text-xs text-ink-soft', locked && 'pointer-events-none opacity-50')}>
              <Switch on={!!sb.studio} onChange={(v) => void toggleStudio(v)} label="Run Supabase Studio" />
              Studio
            </label>
          )}
          {sb.status !== 'none' && !confirmReset && (
            <SmallBtn danger disabled={locked} onClick={() => setConfirmReset(true)} className="ml-auto">{busy === 'reset' ? 'Resetting…' : 'Reset data'}</SmallBtn>
          )}
        </div>
      )}
      {live && confirmReset && (
        <div role="alertdialog" aria-label="Reset dev database" className="mt-2 rounded-md border border-st-error/50 px-2.5 py-2 text-xs text-st-error">
          Delete all data in {project.name}’s dev database? Tables, rows and auth users are wiped and the stack starts empty. This can’t be undone.
          <div className="mt-1.5 flex gap-1.5">
            <button type="button" disabled={locked} onClick={() => void run('reset')} className="rounded-xs bg-st-error px-2 py-0.5 font-semibold text-ground disabled:opacity-50">Reset data</button>
            <button type="button" onClick={() => setConfirmReset(false)} className="px-1 text-ink-soft">Cancel</button>
          </div>
        </div>
      )}
      {error && <div role="alert" className="mt-2 text-xs text-st-error">✕ {error}</div>}
    </div>
  )
}

function UrlRow({ label, value, copyable }: { label: string; value: string; copyable: boolean }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const copy = () => { navigator.clipboard?.writeText(value).then(() => setCopied(true), () => { /* clipboard blocked */ }) }
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <span className="w-9 shrink-0 text-ink-dim">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-ink-soft" title={value}>{value}</span>
      {copyable && (
        <button type="button" onClick={copy} aria-label={`Copy ${label} URL`} className={cx('shrink-0 rounded-xs border border-line px-1.5 text-[11px]', copied ? 'text-st-done' : 'text-ink-dim hover:text-ink')}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      )}
    </div>
  )
}

function SmallBtn({ danger, className, ...rest }: { danger?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest}
      className={cx('rounded-md border px-2.5 py-1 text-xs font-semibold transition duration-[80ms] ease-standard hover:brightness-110 disabled:opacity-50',
        danger ? 'border-st-error/50 text-st-error' : 'border-line bg-raised text-ink', className)} />
  )
}
