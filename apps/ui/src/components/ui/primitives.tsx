// The smallest Ops Deck pieces. Every screen builds on these.
import type { ReactNode } from 'react'
import type { AgentStatus, ModelId, RoleId } from '@/types/colony'
import { STATUS, MOTION_CLASS, modelInfo, ROLES, meterTone } from '@/design/status'

import { cx } from '@/lib/util'

/** Glyph + label, always. Color only reinforces. */
export function StatusBadge({ status, compact = false }: { status: AgentStatus; compact?: boolean }) {
  const s = STATUS[status]
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold',
      compact ? 'px-2 text-[11px]' : 'px-2.5 py-0.5 text-xs', s.badge)}>
      <span aria-hidden="true">{s.glyph}</span>
      {s.label}
    </span>
  )
}

export function ModelBadge({ model, compact = false }: { model: ModelId; compact?: boolean }) {
  const m = modelInfo(model)
  return (
    <span className="whitespace-nowrap rounded-xs border border-line-strong px-1.5 py-0.5 font-mono text-[10px] text-ink-soft"
      title={m.name}>
      {compact ? m.short : m.name.toUpperCase()} {m.pips}
    </span>
  )
}

/** Class tile: code + texture, optional level chip and status glyph corner. */
export function RoleTile({ role, size = 50, level, status }: { role: RoleId; size?: number; level?: number; status?: AgentStatus }) {
  const r = ROLES[role]
  const s = status ? STATUS[status] : null
  return (
    <span className={cx('relative inline-grid shrink-0 place-items-center rounded-lg border bg-raised font-display font-bold text-ink-soft',
      s ? cx('border-2', s.ring, MOTION_CLASS[s.motion]) : 'border-line-strong')}
      style={{ width: size, height: size, fontSize: size * 0.28, backgroundImage: r.texture }}>
      {r.code}
      {level != null && (
        <span className="absolute -bottom-1.5 -right-1.5 rounded-sm border border-line-strong bg-ground px-1 font-display text-[11px]">{level}</span>
      )}
      {s && (
        <span aria-hidden="true" className="absolute -right-2 -top-2 grid h-3.5 min-w-3.5 place-items-center rounded-full font-mono text-[9px] text-ground"
          style={{ background: `var(--color-${s.token})` }}>{s.glyph}</span>
      )}
    </span>
  )
}

/** HUD meter. Thresholds come from Settings → Guards. */
export function Meter({ label, pct, value, sub, warn = 70, critical = 90, neutral = false }: {
  label: string; pct: number; value: ReactNode; sub?: ReactNode; warn?: number; critical?: number; neutral?: boolean
}) {
  const t = neutral ? { bar: 'bg-ink-muted', text: 'text-ink', prefix: '' } : meterTone(pct, warn, critical)
  return (
    <div className="flex min-w-24 flex-col gap-1" role="meter" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <span className="text-label">{label}</span>
      <span className="flex items-baseline gap-1">
        <span className={cx('text-numeral text-[16px]', t.text)}>{t.prefix}{value}</span>
        {sub && <span className="text-[11px] text-ink-dim">{sub}</span>}
      </span>
      <span className="h-1 overflow-hidden rounded-full bg-line-soft">
        <span className={cx('block h-full transition-[width] duration-[240ms] ease-standard', t.bar)} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
    </div>
  )
}

export function KeyHint({ children }: { children: ReactNode }) {
  return <kbd className="rounded-xs border border-line-strong bg-ground px-1.5 font-mono text-[11px] text-ink-soft">{children}</kbd>
}

/** Amber = acts as you (approve, take control, send goal, spawn, found). */
export function Button({ variant = 'secondary', children, kbd, ...rest }: {
  variant?: 'command' | 'primary' | 'secondary' | 'ghost' | 'danger'; kbd?: string; children: ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const v = {
    command: 'bg-you text-you-ink font-bold border-transparent',
    primary: 'bg-ink text-ground font-semibold border-transparent',
    secondary: 'bg-raised text-ink border-line',
    ghost: 'bg-transparent text-ink-soft border-line',
    danger: 'bg-transparent text-st-error border-st-error/50',
  }[variant]
  return (
    <button type="button" {...rest}
      className={cx('inline-flex min-h-9 items-center gap-2 rounded-md border px-3.5 text-[13px] transition duration-[80ms] ease-standard hover:brightness-110 disabled:opacity-50', v, rest.className)}>
      {children}
      {kbd && <span className="rounded-xs border border-current/35 px-1 font-mono text-[11px] opacity-70">{kbd}</span>}
    </button>
  )
}

export function Panel({ title, action, children, tone = 'surface' }: { title?: string; action?: ReactNode; children: ReactNode; tone?: 'surface' | 'well' | 'raised' }) {
  const t = { surface: 'bg-surface border-line', well: 'bg-well border-line-soft', raised: 'bg-raised border-line-strong shadow-raised' }[tone]
  return (
    <section className={cx('rounded-xl border p-4', t)}>
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between">
          {title && <h2 className="text-section">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  )
}
