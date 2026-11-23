import { useEffect, useState } from 'react'
import { useStore } from '@/store/store'
import { inputCls } from '@/components/ui/controls'
import { Button } from '@/components/ui/primitives'
import { cx } from '@/lib/util'
import { useAlertPrefs, setCategoryPref, type AlertCategory } from '@/lib/alertPrefs'
import { useSound } from '@/hooks/useSound'
import { Head, Row, Toggle, card } from './shared'

const ALERT_ROWS: { cat: AlertCategory; g: string; c: string; t: string; d: string; cue: string }[] = [
  { cat: 'critical', g: '✕', c: 'text-st-error', t: 'Critical', d: 'Agent crash · Docker or host down', cue: 'Two low knocks, again after 60 s if unseen' },
  { cat: 'needs_you', g: '◆', c: 'text-st-you', t: 'Needs you', d: 'Merge approval · agent question', cue: 'Rising chime' },
  { cat: 'quest_complete', g: '✓', c: 'text-st-done', t: 'Quest complete', d: 'Batched within 2 s', cue: 'Bright two-note, three on level-up' },
  { cat: 'heads_up', g: '▲', c: 'text-st-blocked', t: 'Heads-up', d: 'Stuck in a loop · limit or budget pace', cue: 'Soft tick' },
]

export function AlertsSection() {
  const { state, dispatch } = useStore()
  const [prefs, setPrefs] = useAlertPrefs()
  const { test } = useSound()
  const box = 'accent-[var(--color-you)]'
  const qh = prefs.quietHours
  const setQh = (patch: Partial<typeof qh>) => setPrefs((p) => ({ ...p, quietHours: { ...p.quietHours, ...patch } }))
  return (
    <>
      <Head title="Alerts & sound" sub="How loudly each kind of event interrupts you." />
      <section className={cx(card, 'grid grid-cols-[1.6fr_.5fr_.5fr_.5fr_1.4fr_auto] items-center text-[13px]')}>
        {['Event', 'Toast', 'Banner', 'Sound', 'Cue', ''].map((h, i) => <span key={i} className="text-label py-2">{h}</span>)}
        {ALERT_ROWS.map((r) => {
          const c = prefs.categories[r.cat]
          return (
            <Row key={r.cat} cells={[
              <span key="t"><b className={cx('font-mono', r.c)}>{r.g}</b> {r.t}<span className="block text-xs text-ink-dim">{r.d}</span></span>,
              <input key="1" type="checkbox" checked={c.toast} onChange={(e) => setCategoryPref(r.cat, { toast: e.target.checked })} aria-label={`Toast for ${r.t}`} className={box} />,
              r.cat === 'quest_complete'
                ? <span key="2" className="text-ink-dim" title="Quest complete has no banner">–</span>
                : <input key="2" type="checkbox" checked={c.banner} onChange={(e) => setCategoryPref(r.cat, { banner: e.target.checked })} aria-label={`Banner for ${r.t}`} className={box} />,
              <input key="3" type="checkbox" checked={c.sound} onChange={(e) => setCategoryPref(r.cat, { sound: e.target.checked })} aria-label={`Sound for ${r.t}`} className={box} />,
              <span key="4" className="text-ink-muted">{r.cue}</span>,
              <button key="5" type="button" onClick={() => test(r.cat, { levelUp: r.cat === 'quest_complete' })} aria-label={`Test the ${r.t} sound`}
                className="rounded-sm border border-line-strong px-2.5 py-1 text-xs">▶ Test</button>,
            ]} />
          )
        })}
      </section>
      <section className={cx(card, 'flex flex-col gap-3')}>
        <Toggle on={!state.ui.muted} onChange={(v) => dispatch({ type: 'mute', muted: !v })} t="Sounds on" d="Global mute is ⇧M from anywhere." />
        <label className="grid grid-cols-[260px_minmax(0,1fr)_64px] items-center gap-4">
          <span><span className="block font-medium">Master volume</span><span className="text-xs text-ink-dim">Every cue plays through this.</span></span>
          <input type="range" min={0} max={100} value={Math.round(prefs.masterVolume * 100)} aria-label="Master volume"
            onChange={(e) => setPrefs((p) => ({ ...p, masterVolume: Number(e.target.value) / 100 }))} className="accent-[var(--color-you)]" />
          <span className="text-numeral text-right text-[17px]">{Math.round(prefs.masterVolume * 100)}%</span>
        </label>
        <Toggle on={prefs.quietInTakeControl} onChange={(v) => setPrefs((p) => ({ ...p, quietInTakeControl: v }))} t="Quiet while I'm in Take control" d="Toasts still appear; only critical sounds play." />
        <div className="flex flex-wrap items-start gap-3">
          <Toggle on={qh.enabled} onChange={(v) => setQh({ enabled: v })} t={`Quiet hours ${qh.start}–${qh.end}`} d="Critical still plays." />
          <span className="ml-auto flex items-center gap-2 text-xs text-ink-muted">
            <input type="time" value={qh.start} onChange={(e) => e.target.value && setQh({ start: e.target.value })} aria-label="Quiet hours start" className={cx(inputCls, 'px-2 py-1')} />
            to
            <input type="time" value={qh.end} onChange={(e) => e.target.value && setQh({ end: e.target.value })} aria-label="Quiet hours end" className={cx(inputCls, 'px-2 py-1')} />
          </span>
        </div>
      </section>
      <DesktopNotifications />
    </>
  )
}

type Perm = NotificationPermission | 'unsupported'
const PERM: Record<Perm, { label: string; cls: string }> = {
  granted: { label: '● Allowed', cls: 'text-st-done' },
  default: { label: '○ Not asked yet', cls: 'text-ink-dim' },
  denied: { label: '✕ Blocked in the browser', cls: 'text-st-error' },
  unsupported: { label: '✕ Not supported here', cls: 'text-ink-dim' },
}

function DesktopNotifications() {
  const read = (): Perm => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  const [perm, setPerm] = useState<Perm>(read)
  // The user can change it in the browser's site settings while this is open.
  useEffect(() => {
    const on = () => setPerm(read())
    window.addEventListener('focus', on)
    return () => window.removeEventListener('focus', on)
  }, [])
  const ask = async () => {
    try { setPerm(await Notification.requestPermission()) } catch { setPerm(read()) }
  }
  return (
    <section className={cx(card, 'flex flex-wrap items-center gap-3')}>
      <span className="min-w-0 flex-1">
        <b className="font-medium">Desktop notifications</b>
        <span className="block text-xs text-ink-dim">Critical and needs-you alerts while this tab is in the background. Click one to jump to Inbox or Review.</span>
      </span>
      <span className={cx('text-xs font-semibold', PERM[perm].cls)}>{PERM[perm].label}</span>
      {perm === 'default' && <Button onClick={ask}>Enable</Button>}
    </section>
  )
}
