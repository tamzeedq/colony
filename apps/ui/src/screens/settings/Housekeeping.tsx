// Settings → Housekeeping (iteration 2 #18–20): how long finished work stays around, and "Clean up now".
import { useEffect, useState } from 'react'
import type { HousekeepingPreview, HousekeepingSettings } from '@/types/colony'
import { useStore } from '@/store/store'
import { endpoints } from '@/api/endpoints'
import { inputCls } from '@/components/ui/controls'
import { cx } from '@/lib/util'
import { Head, card } from './shared'

const FIELDS: { k: keyof HousekeepingSettings; t: string; d: string }[] = [
  { k: 'archiveQuestsAfterDays', t: 'Archive finished quests after', d: 'Done and cancelled quests leave the board and the orchestrator\'s task list. Restorable from "Archived" on the base.' },
  { k: 'keepResolvedAlertsDays', t: 'Remove dismissed Inbox items after', d: 'Counted from when they were dismissed or resolved. Open items are never removed.' },
  { k: 'keepEventsDays', t: 'Remove activity history after', d: 'Old Live feed events. Quests, merges and agents are kept.' },
]

export function Housekeeping() {
  const { mode } = useStore()
  const [settings, setSettings] = useState<HousekeepingSettings | null>(null)
  const [preview, setPreview] = useState<HousekeepingPreview | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<string>('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (mode !== 'live') return
    endpoints.housekeeping().then((r) => { setSettings(r.settings); setPreview(r.preview) }).catch((e) => setErr(String(e?.message ?? e)))
  }, [mode])

  const save = async (k: keyof HousekeepingSettings, v: number) => {
    setErr('')
    try { const r = await endpoints.setHousekeeping({ [k]: v }); setSettings(r.settings); setPreview(r.preview); setResult('') }
    catch (e) { setErr(String((e as Error)?.message ?? e)) }
  }
  const run = async () => {
    setConfirm(false)
    try {
      const r = await endpoints.runHousekeeping()
      setResult(`Archived ${r.questsToArchive} quest(s), removed ${r.alertsToRemove} Inbox item(s) and ${r.eventsToRemove} event(s).`)
      const fresh = await endpoints.housekeeping(); setPreview(fresh.preview)
    } catch (e) { setErr(String((e as Error)?.message ?? e)) }
  }
  const nothing = preview && !preview.questsToArchive && !preview.alertsToRemove && !preview.eventsToRemove

  return (
    <>
      <Head title="Housekeeping" sub="Finished quests, dismissed Inbox items and old history are tidied up automatically, every 6 hours and at start-up. 0 = keep forever." />
      {mode !== 'live' && <div className={cx(card, 'text-[13px] text-ink-muted')}>Connect to a running Colony to change housekeeping.</div>}
      {settings && (
        <section className={cx(card, 'flex flex-col gap-4')}>
          {FIELDS.map((f) => (
            <label key={f.k} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
              <span><span className="block font-medium">{f.t}</span><span className="text-xs text-ink-dim">{f.d}</span></span>
              <span className="flex items-center gap-2 text-xs text-ink-muted">
                <input type="number" min={0} max={3650} defaultValue={settings[f.k]} aria-label={f.t}
                  onBlur={(e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v) && v >= 0 && v !== settings[f.k]) void save(f.k, v) }}
                  className={cx(inputCls, 'w-20 px-2 py-1 text-right')} />
                days
              </span>
            </label>
          ))}
        </section>
      )}
      {preview && (
        <section className={cx(card, 'flex flex-wrap items-center gap-3 text-[13px]')}>
          <span className="min-w-0 flex-1">
            {nothing ? 'Nothing to clean up right now.'
              : <>Clean up now would archive <b>{preview.questsToArchive}</b> quest(s), remove <b>{preview.alertsToRemove}</b> Inbox item(s) and <b>{preview.eventsToRemove}</b> event(s).</>}
            {result && <span className="block text-xs text-st-done">{result}</span>}
          </span>
          {!nothing && (confirm
            ? <span className="flex items-center gap-1.5 text-xs">
                <span className="text-ink-muted">Removed Inbox items and events can't be recovered.</span>
                <button type="button" onClick={run} className="rounded-sm bg-ink px-2.5 py-1 font-semibold text-ground">Clean up</button>
                <button type="button" onClick={() => setConfirm(false)} className="rounded-sm border border-line px-2.5 py-1">Cancel</button>
              </span>
            : <button type="button" onClick={() => setConfirm(true)} className="rounded-md border border-line bg-raised px-3 py-1.5 text-xs">Clean up now</button>)}
        </section>
      )}
      {err && <div className="text-xs text-st-error">{err}</div>}
    </>
  )
}
