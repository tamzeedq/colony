import { KeyHint } from '@/components/ui/primitives'
import { cx } from '@/lib/util'
import { Head, card } from './shared'

export function Keys() {
  const k = [['Jump to base', '1 – 9'], ['World', '0'], ['Roster', 'R'], ['Inbox', 'G I'], ['Next alert', 'G A'], ['Spawn agent', 'S'], ['Found base', 'N'], ['Pause selected', 'Space'], ['Pause everything', '⇧ Space'], ['Take control', 'T'], ['Ambient wall mode', 'W'], ['Command palette', '⌘ K']]
  return (
    <>
      <Head title="Keyboard" sub="Click a key to rebind it (stored in config.toml)." />
      <section className={cx(card, 'grid grid-cols-2 gap-x-7')}>
        {k.map(([l, key]) => <div key={l} className="flex items-center justify-between border-b border-line-soft py-2"><span>{l}</span><button type="button"><KeyHint>{key}</KeyHint></button></div>)}
      </section>
    </>
  )
}
