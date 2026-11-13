// Settings → Security (feedback item 6) and the keep-awake card for Settings → Docker & host
// (feedback item 16). Kept out of Settings.tsx so that file only gains two small hooks.
import { useState } from 'react'
import { useStore } from '@/store/store'
import { Segmented } from '@/components/ui/controls'
import { Button } from '@/components/ui/primitives'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { cx } from '@/lib/util'
import type { KeepAwakeMode, KeepAwakeState } from '@/types/colony'

const card = 'rounded-xl border border-line bg-surface px-5 py-4.5'

const WHERE: [string, string][] = [
  ['Admin token', '.colony/admin-token on this machine. It is printed once, as the pairing link, in the control plane\'s terminal. No container can read it.'],
  ['Claude subscription token', 'CLAUDE_CODE_OAUTH_TOKEN in the repo\'s .env (git-ignored), held in the control plane\'s memory. Every agent container gets it to run Claude Code.'],
  ['Provider keys and GitHub token', 'Encrypted (AES-GCM) in the control plane database with .colony/master.key. Never sent back to the browser or given to agents.'],
  ['Dev Supabase keys', 'The local dev keys of each base\'s stack, kept in the control plane database. Only reachable on that base\'s network.'],
  ['Agent tokens', 'One per agent, stored only as a hash. Rotated on every restart.'],
]

const KEYS_BY_ROLE: [string, string][] = [
  ['Orchestrator · Backend · DevOps · Custom', 'SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY'],
  ['Frontend · QA · Researcher', 'SUPABASE_ANON_KEY only'],
  ['Every agent', 'CLAUDE_CODE_OAUTH_TOKEN and its own Colony token'],
]

const GUARDS = [
  'Activity is scrubbed before it is stored or shown: known keys and anything key-shaped (JWTs, sk-ant-…, ghp_…, sb_secret_…, AKIA…, private keys, KEY=… assignments) become [redacted].',
  'Agent commits that add .env files, key files or key-shaped strings are blocked by a pre-commit hook in the agent image.',
  'request_merge refuses a branch that adds them, and Merge Review flags such files and lines in red.',
  'Publishing to GitHub refuses when an approved merge carried them.',
]

export function SecuritySettings() {
  const { mode } = useStore()
  const live = mode === 'live'
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const rotate = async () => {
    setBusy(true); setNote(null); setConfirm(false)
    try {
      const r = await endpoints.rotateAdminToken()
      setNote({ ok: true, text: `${r?.pairingHint ?? 'Rotated. Re-pair with the new link printed in the control plane terminal.'}${r?.envOverride ? ' Note: COLONY_ADMIN_TOKEN is set in the environment and will be used again on the next start.' : ''}` })
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div>
        <h1 className="m-0 font-display text-[26px] font-semibold">Security</h1>
        <p className="mb-0 mt-1.5 text-ink-muted">Where secrets live, which agents hold which keys, and the admin token.</p>
      </div>
      <section className={cx(card, 'flex flex-col gap-3')}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1">
            <b className="font-medium">Rotate admin token</b>
            <span className="block text-xs text-ink-dim">
              Makes a new admin token and invalidates the old one, including in this browser. The new pairing link is printed only in the control plane&apos;s terminal (the <span className="font-mono">npm start</span> window): open it to re-pair.
            </span>
          </span>
          {!confirm && <Button variant="danger" disabled={!live || busy} onClick={() => setConfirm(true)}>{busy ? 'Rotating…' : 'Rotate admin token'}</Button>}
        </div>
        {confirm && (
          <div role="alertdialog" aria-label="Rotate admin token" className="rounded-md border border-st-error/50 px-3 py-2 text-xs text-st-error">
            This browser loses access until you open the new pairing link from the control plane terminal. Continue?
            <div className="mt-1.5 flex gap-2">
              <button type="button" onClick={() => void rotate()} className="rounded-xs bg-st-error px-2 py-0.5 font-semibold text-ground">Rotate</button>
              <button type="button" onClick={() => setConfirm(false)} className="px-1 text-ink-soft">Cancel</button>
            </div>
          </div>
        )}
        {!live && <span className="text-xs text-ink-dim">Available when connected to a control plane.</span>}
        {note && <div role={note.ok ? 'status' : 'alert'} className={cx('text-xs', note.ok ? 'text-st-done' : 'text-st-error')}>{note.ok ? '✓' : '✕'} {note.text}</div>}
      </section>
      <section className={card}>
        <b>Where secrets live</b>
        <dl className="m-0 mt-2.5 grid grid-cols-[220px_minmax(0,1fr)] gap-x-4 text-[13px]">
          {WHERE.map(([k, v]) => <Pair key={k} k={k} v={v} />)}
        </dl>
      </section>
      <section className={card}>
        <b>Keys each role receives</b>
        <dl className="m-0 mt-2.5 grid grid-cols-[260px_minmax(0,1fr)] gap-x-4 text-[13px]">
          {KEYS_BY_ROLE.map(([k, v]) => <Pair key={k} k={k} v={<span className="font-mono text-xs">{v}</span>} />)}
        </dl>
        <p className="mb-0 mt-2.5 text-xs text-ink-dim">Agents started before a change keep the keys they booted with until they restart.</p>
      </section>
      <section className={card}>
        <b>Guardrails</b>
        <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0 text-[13px] text-ink-soft">
          {GUARDS.map((g) => <li key={g} className="flex gap-2"><span className="text-st-done">✓</span><span>{g}</span></li>)}
        </ul>
      </section>
    </>
  )
}

function Pair({ k, v }: { k: string; v: React.ReactNode }) {
  return <><dt className="border-t border-line-soft py-2 font-medium">{k}</dt><dd className="m-0 border-t border-line-soft py-2 text-ink-soft">{v}</dd></>
}

const MODES: { id: KeepAwakeMode; label: string }[] = [
  { id: 'off', label: 'Off' }, { id: 'working', label: 'While agents are working' }, { id: 'always', label: 'Always' },
]

/** Settings → Docker & host: keep the machine awake (feedback item 16). */
export function KeepAwakeCard() {
  const { state, mode } = useStore()
  const live = mode === 'live'
  const fromSnapshot = state.resources.keepAwake
  const [local, setLocal] = useState<KeepAwakeState | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // The snapshot is the truth; a just-set mode wins until the next resources update catches up.
  const snap = live && fromSnapshot && (!local || local.mode === fromSnapshot.mode) ? fromSnapshot : undefined
  const ka: KeepAwakeState = snap ?? local ?? fromSnapshot ?? { mode: 'off', active: false, reason: live ? 'Off' : 'Off (mock)' }

  const set = async (m: KeepAwakeMode) => {
    setError('')
    if (!live) { setLocal({ mode: m, active: m === 'always', reason: m === 'off' ? 'Off (mock)' : m === 'always' ? 'Always while Colony runs' : 'No agents working' }); return }
    setBusy(true)
    try { setLocal(await endpoints.setKeepAwake(m)) } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <section className={cx(card, 'flex flex-col gap-3')}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1">
          <b className="font-medium">Keep this computer awake</b>
          <span className="block text-xs text-ink-dim">
            Sleep pauses Docker, so agents stop mid-task. Only the system stays awake: the display can still turn off and the screen still locks. &quot;While agents are working&quot; releases 3 minutes after every agent is idle.
          </span>
        </span>
        <span className={cx('text-xs font-semibold', ka.unsupported ? 'text-st-error' : ka.active ? 'text-st-done' : 'text-ink-dim')}>
          {ka.unsupported ? '✕ ' : ka.active ? '● Awake · ' : '○ '}{ka.reason}
        </span>
      </div>
      <div className={cx(busy && 'pointer-events-none opacity-60')}>
        <Segmented label="Keep awake" value={ka.mode} onChange={(m) => void set(m)} options={MODES} />
      </div>
      {error && <div role="alert" className="text-xs text-st-error">✕ {error}</div>}
    </section>
  )
}
