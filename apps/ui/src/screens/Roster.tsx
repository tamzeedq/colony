import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AgentStatus, ModelId, RoleId } from '@/types/colony'
import { useStore } from '@/store/store'
import { AgentCard } from '@/components/agent/AgentCard'
import { Chip } from '@/components/ui/controls'
import { Button, KeyHint } from '@/components/ui/primitives'
import { cx } from '@/lib/util'

const ORDER: AgentStatus[] = ['error', 'waiting', 'blocked', 'running', 'editing', 'thinking', 'booting', 'idle', 'paused', 'done']
const STATUS_FILTERS: { id: string; label: string; match: (s: AgentStatus) => boolean }[] = [
  { id: 'any', label: 'Any', match: () => true },
  { id: 'you', label: '! Needs you', match: (s) => s === 'waiting' },
  { id: 'error', label: '✕ Error', match: (s) => s === 'error' },
  { id: 'work', label: '› Working', match: (s) => ['running', 'editing', 'thinking'].includes(s) },
  { id: 'paused', label: '‖ Paused', match: (s) => s === 'paused' },
]

export function Roster() {
  const { state, dispatch } = useStore()
  const [project, setProject] = useState('all')
  const [role, setRole] = useState<RoleId | 'all'>('all')
  const [model, setModel] = useState<ModelId | 'all'>('all')
  const [status, setStatus] = useState('any')
  const [q, setQ] = useState('')
  const sel = state.ui.selected
  const list = useMemo(() => state.agents
    .filter((a) => project === 'all' || a.projectId === project)
    .filter((a) => role === 'all' || a.role === role)
    .filter((a) => model === 'all' || a.model === model)
    .filter((a) => STATUS_FILTERS.find((f) => f.id === status)!.match(a.status))
    .filter((a) => !q || `${a.callsign} ${a.currentAction ?? ''} ${a.branch ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)), [state.agents, project, role, model, status, q])
  const toggle = (id: string) => dispatch({ type: 'select', ids: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] })

  return (
    <main className="flex flex-col gap-4 px-7 pb-7 pt-5.5">
      <div className="flex flex-wrap items-end gap-4">
        <div><div className="text-label mb-1.5">Roster</div><h1 className="m-0 font-display text-[30px] font-semibold">{state.agents.length} agents across {state.projects.length} bases</h1></div>
        <div className="flex-1" />
        <label className="flex w-[260px] max-w-full items-center gap-2 rounded-md border border-line bg-surface px-3">
          <span aria-hidden="true" className="text-ink-dim">⌕</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search callsign, task, branch" aria-label="Search agents" className="min-w-0 flex-1 bg-transparent py-2.5 text-[13px] outline-none" />
        </label>
        <Link to="/spawn" className="inline-flex items-center gap-2.5 rounded-lg bg-you px-4.5 py-2.5 text-sm font-bold text-you-ink no-underline">+ Spawn agent <KeyHint>S</KeyHint></Link>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-lg border border-line-soft bg-well px-3.5 py-2.5">
        <Group label="Base">
          <Chip on={project === 'all'} onClick={() => setProject('all')}>All</Chip>
          {state.projects.map((p) => <Chip key={p.id} on={project === p.id} onClick={() => setProject(p.id)}>{p.name}</Chip>)}
        </Group>
        <Group label="Class">
          {(['all', 'orchestrator', 'backend', 'frontend', 'qa', 'devops', 'researcher'] as const).map((r) => <Chip key={r} on={role === r} onClick={() => setRole(r)}>{r === 'all' ? 'All' : r === 'orchestrator' ? 'ORC' : r === 'researcher' ? 'RES' : r === 'devops' ? 'OPS' : r === 'frontend' ? 'FE' : r === 'backend' ? 'BE' : 'QA'}</Chip>)}
        </Group>
        <Group label="Model">
          {(['all', 'opus-5.5', 'sonnet-5.5', 'haiku-5.5', 'fable-5.1'] as const).map((m) => <Chip key={m} on={model === m} onClick={() => setModel(m)}>{m === 'all' ? 'All' : m.split('-')[0][0].toUpperCase() + m.split('-')[0].slice(1)}</Chip>)}
        </Group>
        <Group label="Status">{STATUS_FILTERS.map((f) => <Chip key={f.id} on={status === f.id} onClick={() => setStatus(f.id)}>{f.label}</Chip>)}</Group>
      </div>

      {sel.length > 0 && (
        <div role="toolbar" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 rounded-lg border border-you/35 bg-you/8 px-3 py-2">
          <span className="mr-2 text-[13px] font-semibold text-you">{sel.length} selected</span>
          <Button kbd="Space" onClick={() => dispatch({ type: 'pause', ids: sel })}>‖ Pause</Button>
          <Button onClick={() => dispatch({ type: 'resume', ids: sel })}>▸ Resume</Button>
          <Button onClick={() => dispatch({ type: 'downshift' })}>⇣ Downshift to Haiku</Button>
          <Button variant="danger" onClick={() => dispatch({ type: 'kill', ids: sel })}>✕ Kill</Button>
          <button type="button" onClick={() => dispatch({ type: 'select', ids: [] })} className="ml-auto px-2.5 text-xs text-ink-muted">Clear selection · Esc</button>
        </div>
      )}

      <div className={cx('grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3.5')}>
        {list.map((a) => <AgentCard key={a.id} agent={a} selected={sel.includes(a.id)} onToggle={() => toggle(a.id)} />)}
      </div>
      {!list.length && <p className="text-sm text-ink-dim">No agents match these filters.</p>}
    </main>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5"><span className="text-label mr-0.5">{label}</span>{children}</div>
}

