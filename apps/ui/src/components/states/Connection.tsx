// Live-mode connection states: Pair (no token), Connecting (no snapshot yet) and the
// Reconnecting banner shown under the HUD while the stream is down.
import { useEffect, useState } from 'react'
import { useStore } from '@/store/store'
import { clearToken } from '@/api/token'
import { Logo } from '@/components/hud/AppShell'
import { Field, inputCls } from '@/components/ui/controls'
import { Button } from '@/components/ui/primitives'
import { cx } from '@/lib/util'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-ground text-ink">
      <header className="flex items-center border-b border-line-soft bg-hud px-5 py-3.5"><Logo /></header>
      <div className="grid flex-1 place-items-center p-8">{children}</div>
    </div>
  )
}

export function PairScreen() {
  const { pair, conn } = useStore()
  const [token, setToken] = useState('')
  return (
    <Frame>
      <form className="flex w-[min(460px,92vw)] flex-col gap-4 rounded-xl border border-line bg-surface p-6"
        onSubmit={(e) => { e.preventDefault(); if (token.trim()) pair(token.trim()) }}>
        <div>
          <div className="text-label mb-1.5">Ops Deck · not paired</div>
          <h1 className="m-0 font-display text-[24px] font-semibold">Pair with your control plane</h1>
        </div>
        <p className="m-0 text-[13px] leading-relaxed text-ink-muted">Start the control plane and open the link it prints, or paste the token from <span className="font-mono text-xs text-ink-soft">.colony/admin-token</span>.</p>
        <ol className="m-0 rounded-lg border border-line-soft bg-well py-2.5 pl-8 pr-3 text-[13px] leading-[1.8] text-ink-soft">
          <li>Start the control plane on this machine</li>
          <li>Open <span className="font-mono text-xs">http://localhost:5173/#pair=…</span> from its log, or</li>
          <li>Paste the admin token below</li>
        </ol>
        <Field label="Admin token" hint={conn.rejected ? undefined : 'Stored in this browser only. Nothing on the host adds it for you.'}>
          <input type="password" autoFocus autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)}
            placeholder="Paste token" aria-label="Admin token" className={cx(inputCls, 'font-mono text-[13px]', conn.rejected && 'border-st-error/60')} />
        </Field>
        {conn.rejected && <div role="alert" className="-mt-2 text-xs text-st-error">✕ The control plane rejected the stored token. Paste the current one.</div>}
        <div className="flex items-center justify-end gap-2.5">
          <span className="mr-auto text-xs text-ink-dim">Add <span className="font-mono">?mock</span> to the URL for the design demo</span>
          <Button variant="command" type="submit" disabled={!token.trim()}>◆ Pair</Button>
        </div>
      </form>
    </Frame>
  )
}

function useRetryCountdown(retryAt?: number) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!retryAt) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [retryAt])
  return retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0
}

export function ConnectingScreen() {
  const { conn, retryNow } = useStore()
  const s = conn.stream
  const secs = useRetryCountdown(s.retryAt)
  const failing = s.attempt > 0
  return (
    <Frame>
      <div className="flex max-w-[420px] flex-col items-center gap-3.5 text-center">
        <div className="relative h-24 w-24 bg-line [clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)]">
          <div className="absolute inset-0.5 grid place-items-center bg-ground font-display text-3xl text-st-run [clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)]">
            <span className="animate-breathe">◌</span>
          </div>
        </div>
        <h1 className="m-0 font-display text-xl font-semibold">{failing ? 'Control plane unreachable' : 'Connecting to the control plane…'}</h1>
        <p className="m-0 text-[13px] leading-normal text-ink-muted">
          {failing ? <>Colony keeps retrying{secs ? <> · next try in {secs}s</> : '…'}{s.lastError ? <><br /><span className="text-ink-dim">{s.lastError}</span></> : null}</> : 'Waiting for the first snapshot.'}
        </p>
        {failing && (
          <div className="flex gap-2">
            <Button onClick={retryNow}>↻ Retry now</Button>
            <Button variant="ghost" onClick={clearToken}>Pair again</Button>
          </div>
        )}
      </div>
    </Frame>
  )
}

/** Pinned under the HUD while the stream is down. */
export function ReconnectingBanner() {
  const { mode, conn, retryNow } = useStore()
  const s = conn.stream
  const secs = useRetryCountdown(s.retryAt)
  if (mode !== 'live' || s.state === 'open') return null
  return (
    <div role="status" className="flex items-center gap-3 border-b border-st-blocked/40 bg-st-blocked/12 px-5 py-2 text-[13px] text-st-blocked">
      <span className="animate-breathe font-mono">◌</span>
      <span className="font-semibold">Reconnecting…</span>
      <span className="text-ink-muted">Live updates paused{secs ? ` · retry in ${secs}s` : ''}{s.lastError ? ` · ${s.lastError}` : ''}. What you see may be stale.</span>
      <button type="button" onClick={retryNow} className="ml-auto rounded-sm border border-st-blocked/50 px-2.5 py-1 text-xs font-semibold">↻ Retry now</button>
    </div>
  )
}
