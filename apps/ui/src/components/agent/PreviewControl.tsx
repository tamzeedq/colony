// Preview an agent's dev server in your browser (feedback #19). Colony forwards a port on
// 127.0.0.1 to the dev server inside the agent's container; it must listen on 0.0.0.0 there.
import { useEffect, useState } from 'react'
import type { Agent } from '@/types/colony'
import { endpoints, type PreviewInfo } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { useStore } from '@/store/store'
import { cx } from '@/lib/util'

export function PreviewControl({ agent }: { agent: Agent }) {
  const { mode } = useStore()
  const [info, setInfo] = useState<PreviewInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (mode !== 'live' || !open) return
    endpoints.preview(agent.id).then((i) => { setInfo(i); setPort((p) => p || String(i.active?.targetPort ?? i.suggestedPorts[0] ?? '')) }, () => {})
  }, [agent.id, mode, open])

  if (mode !== 'live') return null
  const active = info?.active
  const start = async () => {
    setBusy(true); setErr('')
    try {
      const a = await endpoints.startPreview(agent.id, Number(port))
      setInfo((i) => ({ suggestedPorts: i?.suggestedPorts ?? [], active: a }))
      window.open(a.url, '_blank', 'noopener,noreferrer')
    } catch (e) { setErr(errorMessage(e)) } finally { setBusy(false) }
  }
  const stop = async () => {
    setBusy(true); setErr('')
    try { await endpoints.stopPreview(agent.id); setInfo((i) => (i ? { ...i, active: null } : i)) } catch (e) { setErr(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className={cx('inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 text-[13px]', active ? 'border-st-done/50 text-st-done' : 'border-line bg-raised text-ink')}>
        ◳ Preview{active ? ` · :${active.targetPort}` : ''}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-[300px] rounded-lg border border-line bg-raised p-3 text-xs shadow-raised">
          <p className="m-0 mb-2 text-ink-muted">Open a dev server running in {agent.callsign}’s container, on this machine only. The server must listen on <code className="font-mono">0.0.0.0</code> (e.g. <code className="font-mono">--host 0.0.0.0</code>).</p>
          {active
            ? (
              <div className="flex flex-col gap-2">
                <a href={active.url} target="_blank" rel="noreferrer" className="font-mono text-you">{active.url} ↗</a>
                <span className="text-ink-dim">→ port {active.targetPort} in the container</span>
                <button type="button" disabled={busy} onClick={() => void stop()} className="self-start rounded-md border border-line px-2.5 py-1 text-ink-soft disabled:opacity-50">Stop preview</button>
              </div>
            )
            : (
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2">Port in container
                  <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} inputMode="numeric" aria-label="Dev server port"
                    className="w-20 rounded-sm border border-line bg-well px-2 py-1 font-mono text-ink" />
                </label>
                {!!info?.suggestedPorts.length && (
                  <div className="flex flex-wrap gap-1">
                    {info.suggestedPorts.map((p) => (
                      <button key={p} type="button" onClick={() => setPort(String(p))} className={cx('rounded-full border px-2 py-0.5 font-mono', String(p) === port ? 'border-ink bg-ink text-ground' : 'border-line text-ink-soft')}>{p}</button>
                    ))}
                  </div>
                )}
                <button type="button" disabled={busy || !port} onClick={() => void start()} className="self-start rounded-md bg-you px-2.5 py-1 font-semibold text-you-ink disabled:opacity-50">Open preview ↗</button>
              </div>
            )}
          {err && <p className="m-0 mt-2 text-st-error">✕ {err}</p>}
        </div>
      )}
    </div>
  )
}
