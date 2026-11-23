// Agents started on an older image or older role instructions (iteration 1 #6).
import { useState } from 'react'
import type { Agent } from '@/types/colony'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { useStore } from '@/store/store'

const reasonText = (r: NonNullable<Agent['outdated']>) =>
  r.includes('image') && r.includes('instructions') ? 'an older image and older instructions'
    : r.includes('image') ? 'an older agent image' : 'older instructions'

/** Small chip for cards. */
export function OutdatedChip({ agent }: { agent: Agent }) {
  if (!agent.outdated?.length) return null
  return <span title={`Running ${reasonText(agent.outdated)}. Restart to update.`} className="shrink-0 rounded-full border border-st-blocked/50 px-1.5 text-[10px] font-semibold text-st-blocked">↻ update</span>
}

/** Banner for the Inspector with a one-click restart to update. */
export function OutdatedBanner({ agent }: { agent: Agent }) {
  const { mode } = useStore()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!agent.outdated?.length) return null
  const busyNow = ['running', 'editing', 'thinking'].includes(agent.status)
  const go = async () => {
    setBusy(true); setErr('')
    try { if (mode === 'live') await endpoints.updateAgent(agent.id) } catch (e) { setErr(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-st-blocked/40 bg-st-blocked/10 px-5 py-2 text-xs">
      <span className="text-st-blocked">↻ {agent.callsign} is running {reasonText(agent.outdated)}.</span>
      <span className="text-ink-dim">Restarting picks up the latest{agent.outdated.includes('instructions') ? ' instructions' : ''}{agent.outdated.includes('image') ? ' image' : ''} and resumes its session.{busyNow ? ' It is mid-task; it will be interrupted.' : ''}</span>
      <button type="button" disabled={busy || mode !== 'live'} onClick={() => void go()} className="ml-auto rounded-md border border-st-blocked/60 px-2.5 py-1 font-semibold text-st-blocked disabled:opacity-50">{busy ? 'Restarting…' : 'Restart to update'}</button>
      {err && <span className="w-full text-st-error">✕ {err}</span>}
    </div>
  )
}

/** Roster header button: restart every outdated agent that isn't mid-task. */
export function RestartOutdatedButton() {
  const { state, mode } = useStore()
  const [note, setNote] = useState('')
  const n = state.agents.filter((a) => a.outdated?.length).length
  if (!n || mode !== 'live') return null
  const go = async () => {
    setNote('Restarting…')
    try {
      const r = await endpoints.restartOutdated()
      setNote(`Restarted ${r.restarted.length}${r.skipped.length ? ` · ${r.skipped.length} busy, left for later` : ''}`)
    } catch (e) { setNote(`✕ ${errorMessage(e)}`) }
  }
  return (
    <span className="flex items-center gap-2">
      <button type="button" onClick={() => void go()} className="rounded-lg border border-st-blocked/60 px-3.5 py-2.5 text-sm font-semibold text-st-blocked">↻ Restart outdated ({n})</button>
      {note && <span className="text-xs text-ink-dim">{note}</span>}
    </span>
  )
}
