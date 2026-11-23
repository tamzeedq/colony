import { useStore } from '@/store/store'
import { Field, inputCls } from '@/components/ui/controls'
import { cx } from '@/lib/util'
import { KeepAwakeCard } from '../SecuritySettings'
import { Head, card } from './shared'

export function Docker() {
  const { state, mode } = useStore()
  const f = [['Default image', 'colony/agent:node22', 'Per-base override in base settings'], ['Max containers', String(state.resources.containers.max), 'Fits your host RAM at 4 GB each'],
    ['Memory per agent', '4 GB', 'Restart with more from a crash alert'], ['CPU per agent', '2 cores', 'Soft limit (cpu-shares)'], ['Worktrees folder', '~/colony/worktrees', 'One git worktree per agent'], ['Supabase CLI', 'supabase', 'Used to provision dev backends']]
  return (
    <>
      <Head title="Docker & host" sub="Where agents run and how big each container can get." />
      <section className={cx(card, 'grid grid-cols-2 gap-4')}>
        <div className="col-span-2 flex items-center gap-3"><b>Docker daemon</b><span className={cx('text-xs font-semibold', state.resources.host.docker === 'running' ? 'text-st-done' : 'text-st-error')}>{state.resources.host.docker === 'running' ? '● Running' : '✕ Down'}</span><span className="font-mono text-xs text-ink-muted">unix:///var/run/docker.sock</span></div>
        {f.map(([l, v, h]) => <Field key={l} label={l} hint={h}><input defaultValue={v} readOnly={mode === 'live'} className={cx(inputCls, 'font-mono text-[13px]', mode === 'live' && 'text-ink-muted')} /></Field>)}
        {mode === 'live' && <p className="col-span-2 m-0 text-xs text-ink-dim">Read-only here; the control plane's config sets these.</p>}
      </section>
      <KeepAwakeCard />
    </>
  )
}
