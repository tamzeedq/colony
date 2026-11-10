import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/store/store'
import { KeyHint } from '@/components/ui/primitives'
import { cx } from '@/lib/util'

const KEYS: [string, [string, string][]][] = [
  ['Navigate', [['Jump to base', '1 – 9'], ['World overview', '0'], ['Roster', 'R'], ['Inbox', 'G I'], ['Next alert', 'G A'], ['Ambient wall mode', 'W']]],
  ['Selected agent', [['Pause / resume', 'Space'], ['Take control / hand back', 'T'], ['Close inspector', 'Esc']]],
  ['Create', [['Spawn agent', 'S'], ['Found new base', 'N']]],
  ['Global', [['Pause everything', '⇧ Space'], ['Mute sounds', '⇧ M'], ['Command palette', '⌘ K'], ['This overlay', '?']]],
]

function Modal({ children, label, onClose }: { children: React.ReactNode; label: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] grid place-items-start justify-center bg-[rgb(5_7_10/.62)] pt-[12vh]" onClick={onClose}>
      <div role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()} className="w-[min(720px,92vw)] animate-pop rounded-2xl border border-line-strong bg-surface p-5 shadow-raised">
        {children}
      </div>
    </div>
  )
}

export function ShortcutOverlay() {
  const { state, dispatch } = useStore()
  if (state.ui.overlay !== 'shortcuts') return null
  return (
    <Modal label="Keyboard shortcuts" onClose={() => dispatch({ type: 'overlay', overlay: null })}>
      <h2 className="mb-3 font-display text-xl font-semibold">Keyboard</h2>
      <div className="grid grid-cols-2 gap-x-6">
        {KEYS.map(([group, rows]) => (
          <div key={group} className="mb-3">
            <div className="mb-1 text-xs font-semibold text-you">{group}</div>
            {rows.map(([l, k]) => <div key={l} className="flex items-center justify-between border-b border-line-soft py-1.5 text-[13px] text-ink-soft"><span>{l}</span><KeyHint>{k}</KeyHint></div>)}
          </div>
        ))}
      </div>
    </Modal>
  )
}

export function CommandPalette() {
  const { state, dispatch } = useStore()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const items = useMemo(() => {
    const go = (to: string) => () => nav(to)
    const all = [
      ...state.projects.map((p) => ({ label: `Go to ${p.name}`, hint: String(p.key), run: go(`/base/${p.key}`) })),
      ...state.agents.map((a) => ({ label: `Inspect ${a.callsign}`, hint: a.role, run: () => dispatch({ type: 'inspect', id: a.id }) })),
      { label: 'Spawn agent', hint: 'S', run: go('/spawn') }, { label: 'Found new base', hint: 'N', run: go('/new') },
      { label: 'Open inbox', hint: 'G I', run: go('/inbox') }, { label: 'Settings · Limits & budgets', hint: '', run: go('/settings/limits') },
      { label: 'Pause everything', hint: '⇧ Space', run: () => dispatch({ type: 'pauseAll' }) },
      { label: 'Downshift workers to Haiku', hint: '', run: () => dispatch({ type: 'downshift' }) },
      { label: 'Ambient wall mode', hint: 'W', run: go('/ambient') },
    ]
    const t = q.toLowerCase()
    return all.filter((x) => x.label.toLowerCase().includes(t)).slice(0, 9)
  }, [q, state.projects, state.agents, nav, dispatch])
  if (state.ui.overlay !== 'palette') return null
  const close = () => { dispatch({ type: 'overlay', overlay: null }); setQ(''); setI(0) }
  const run = (k: number) => { items[k]?.run(); close() }
  return (
    <Modal label="Command palette" onClose={close}>
      <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setI(0) }} placeholder="Type a command, agent or base…" aria-label="Command"
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)) } if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)) } if (e.key === 'Enter') run(i) }}
        className="mb-2 w-full rounded-md border border-line bg-ground px-3 py-2.5 text-[15px]" />
      <ul className="m-0 list-none p-0">
        {items.map((x, k) => (
          <li key={x.label}><button type="button" onMouseEnter={() => setI(k)} onClick={() => run(k)}
            className={cx('flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm', k === i ? 'bg-raised text-ink' : 'text-ink-soft')}>
            {x.label}{x.hint && <span className="font-mono text-[11px] text-ink-dim">{x.hint}</span>}
          </button></li>
        ))}
      </ul>
    </Modal>
  )
}
