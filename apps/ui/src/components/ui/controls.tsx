import type { ReactNode } from 'react'
import { cx } from '@/lib/util'

export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: { id: T; label: ReactNode; kbd?: string }[]; value: T; onChange: (id: T) => void; className?: string
}) {
  return (
    <div role="tablist" className={cx('flex gap-1 border-b border-line-soft', className)}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}
          className={cx('border-b-2 px-3 pb-2.5 pt-3 text-[13px] font-semibold transition-colors duration-[160ms]',
            t.id === value ? 'border-you text-ink' : 'border-transparent text-ink-dim hover:text-ink-soft')}>
          {t.label}{t.kbd && <span className="ml-1.5 font-mono text-[10px] font-normal text-ink-dim">{t.kbd}</span>}
        </button>
      ))}
    </div>
  )
}

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void; label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-md border border-line bg-surface p-0.5">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} onClick={() => onChange(o.id)}
          className={cx('rounded-sm px-2.5 py-1 text-xs', o.id === value ? 'bg-ink font-semibold text-ground' : 'text-ink-soft hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Chip({ on, children, onClick }: { on?: boolean; children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={cx('rounded-full border px-2.5 py-1 text-xs', on ? 'border-ink bg-ink text-ground' : 'border-line text-ink-soft hover:border-line-strong')}>
      {children}
    </button>
  )
}

export function Switch({ on, onChange, label, accent = 'bg-st-done' }: { on: boolean; onChange: (v: boolean) => void; label: string; accent?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={cx('relative h-6 w-10 shrink-0 rounded-full transition-colors duration-[160ms]', on ? accent : 'bg-line-strong')}>
      <span className={cx('absolute top-1 h-4 w-4 rounded-full bg-ground transition-[left] duration-[160ms] ease-standard', on ? 'left-5' : 'left-1')} />
    </button>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-ink-muted">
      {label}
      {children}
      {hint && <span className="text-ink-dim">{hint}</span>}
    </label>
  )
}

export const inputCls = 'rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-line-strong'

export function Bar({ pct, className = 'bg-ink-muted', h = 'h-1' }: { pct: number; className?: string; h?: string }) {
  return <span className={cx('block overflow-hidden rounded-full bg-line', h)}><span className={cx('block h-full', className)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></span>
}

export function Segments({ value, of = 10, className }: { value: number; of?: number; className: string }) {
  return (
    <span className="flex flex-1 gap-[3px]" aria-hidden="true">
      {Array.from({ length: of }, (_, i) => <span key={i} className={cx('h-1.5 flex-1 rounded-[1px]', i < value ? className : 'bg-line')} />)}
    </span>
  )
}
