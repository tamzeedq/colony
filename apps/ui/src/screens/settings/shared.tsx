import { Switch } from '@/components/ui/controls'

export function Head({ title, sub }: { title: string; sub: string }) {
  return <div><h1 className="m-0 font-display text-[26px] font-semibold">{title}</h1><p className="mb-0 mt-1.5 text-ink-muted">{sub}</p></div>
}
export const card = 'rounded-xl border border-line bg-surface px-5 py-4.5'

export function Row({ cells }: { cells: React.ReactNode[] }) {
  return <>{cells.map((c, i) => <span key={i} className="flex items-center border-t border-line-soft py-2">{c}</span>)}</>
}

export function Toggle({ on, onChange, t, d }: { on: boolean; onChange: (v: boolean) => void; t: string; d: string }) {
  return <div className="flex items-start gap-3"><Switch on={on} onChange={onChange} label={t} accent="bg-you" /><span><b className="font-medium">{t}</b><span className="block text-xs text-ink-dim">{d}</span></span></div>
}
