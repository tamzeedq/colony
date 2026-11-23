import { useStore } from '@/store/store'
import { Field, inputCls } from '@/components/ui/controls'
import { cx } from '@/lib/util'
import { Head, card } from './shared'

export function Roles() {
  const { state } = useStore()
  const roles = Array.from(new Set(state.agents.map((a) => a.role)))
  const sample = state.agents.find((a) => a.role === 'backend')
  return (
    <>
      <Head title="Role library" sub="Reusable role prompts. Agents copy one when spawned; editing here never changes running agents." />
      <div className="flex flex-wrap gap-4">
        <div className="flex max-w-[280px] flex-[1_1_240px] flex-col gap-1">
          {roles.map((r) => <div key={r} className={cx('rounded-md border px-2.5 py-2 capitalize', r === 'backend' ? 'border-you bg-raised' : 'border-transparent')}>{r} <span className="text-xs text-ink-dim">· {state.agents.filter((a) => a.role === r).length} agents</span></div>)}
        </div>
        <div className={cx(card, 'flex min-w-0 flex-[3_1_420px] flex-col gap-3')}>
          <b className="font-display text-lg font-semibold">Backend</b>
          <Field label="Role prompt"><textarea rows={8} defaultValue={sample?.rolePrompt} className={cx(inputCls, 'font-mono text-xs leading-relaxed')} /></Field>
          <div className="text-xs text-ink-dim">Variables: {'{project} {stack} {goal} {orchestrator}'}</div>
        </div>
      </div>
    </>
  )
}
