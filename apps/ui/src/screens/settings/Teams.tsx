import { Button } from '@/components/ui/primitives'
import { cx } from '@/lib/util'
import { Head } from './shared'

export function Teams() {
  const t = [['Solo HQ', 'ORC · Opus 5.5', '~1 container'], ['HQ + 2 workers', 'ORC · Opus 5.5\nFE  · Sonnet 5.5\nBE  · Sonnet 5.5', 'Default · 3 containers'],
    ['Full squad', 'ORC · Opus 5.5\nFE  · Sonnet 5.5\nBE  · Sonnet 5.5\nQA  · Haiku 5.5\nOPS · Sonnet 5.5', '5 containers'], ['Research spike', 'ORC · Opus 5.5\nRES · Haiku 5.5 ×2', 'Read-only tools'], ['Bug bash', 'ORC · Sonnet 5.5\nQA  · Haiku 5.5 ×3', 'Opens issues, no merges']]
  return (
    <>
      <Head title="Team templates" sub="Starting squads offered when you found a base." />
      <div className="grid grid-cols-3 gap-3">
        {t.map(([n, u, c]) => (
          <div key={n} className={cx('flex flex-col gap-2.5 rounded-xl border bg-surface p-4', c.startsWith('Default') ? 'border-you' : 'border-line')}>
            <b className="font-display text-[17px] font-semibold">{n}</b>
            <pre className="m-0 whitespace-pre-line font-mono text-xs text-ink-soft">{u}</pre>
            <span className="text-xs text-ink-dim">{c}</span>
            <div className="flex gap-1.5"><Button variant="ghost">Edit</Button><Button variant="ghost">Duplicate</Button></div>
          </div>
        ))}
        <button type="button" className="min-h-40 rounded-xl border border-dashed border-line-strong text-ink-muted">+ New template</button>
      </div>
    </>
  )
}
