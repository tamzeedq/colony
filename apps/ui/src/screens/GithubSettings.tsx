// Settings → GitHub (docs/phase6.md "GitHub"): the commander's fine-grained token. Write-only:
// the control plane answers with { configured, status, login?, testedAt? } and never the token.
import { useEffect, useState } from 'react'
import { useStore } from '@/store/store'
import { Field, inputCls } from '@/components/ui/controls'
import { Button } from '@/components/ui/primitives'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { ago, cx } from '@/lib/util'
import type { GithubTokenStatus } from '@/types/colony'

const card = 'rounded-xl border border-line bg-surface px-5 py-4.5'
const STATUS: Record<GithubTokenStatus['status'], { label: string; cls: string }> = {
  connected: { label: '● Connected', cls: 'text-st-done' },
  untested: { label: '○ Untested', cls: 'text-st-idle' },
  error: { label: '✕ Error', cls: 'text-st-error' },
  missing: { label: '○ No token', cls: 'text-ink-dim' },
}
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'

export function GithubSettings() {
  const { mode } = useStore()
  const live = mode === 'live'
  const [st, setSt] = useState<GithubTokenStatus | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'' | 'save' | 'remove' | 'test'>('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (!live) { setSt({ configured: false, status: 'missing' }); return }
    let on = true
    endpoints.github().then((s) => { if (on) setSt(s) }, (e) => { if (on) setNote({ ok: false, text: errorMessage(e) }) })
    return () => { on = false }
  }, [live])

  const run = async (what: 'save' | 'remove' | 'test') => {
    setBusy(what); setNote(null)
    try {
      if (what === 'save') {
        setSt(await endpoints.putGithubToken(token.trim()))
        setToken('')
        setNote({ ok: true, text: 'Saved · encrypted on the control plane. Run Test to check it.' })
      } else if (what === 'remove') {
        setSt(await endpoints.deleteGithubToken())
        setNote({ ok: true, text: 'Token removed' })
      } else {
        const s = await endpoints.testGithub()
        setSt(s)
        setNote(s.status === 'connected' ? { ok: true, text: `Token works · signed in as ${s.login ?? 'unknown'}` } : { ok: false, text: s.statusDetail ?? 'Test failed' })
      }
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e) })
    } finally {
      setBusy('')
    }
  }

  const view = STATUS[st?.status ?? 'missing']
  return (
    <>
      <div>
        <h1 className="m-0 font-display text-[26px] font-semibold">GitHub</h1>
        <p className="mb-0 mt-1.5 text-ink-muted">Send merged work back to GitHub when you click Publish in a base’s Infra panel.</p>
      </div>
      <section className={cx(card, 'flex flex-col gap-3')}>
        <div className="flex flex-wrap items-center gap-3">
          <b className="font-display text-[17px] font-semibold">Personal access token</b>
          {st?.login && <span className="font-mono text-xs text-ink-muted">@{st.login}</span>}
          <span className={cx('ml-auto text-xs font-semibold', view.cls)}>{view.label}</span>
          {st?.testedAt && <span className="text-xs text-ink-dim">tested {ago(st.testedAt)} ago</span>}
        </div>
        {st?.status === 'error' && st.statusDetail && !note && <div className="text-xs text-st-error">✕ {st.statusDetail}</div>}
        <p className="m-0 text-xs leading-normal text-ink-dim">
          Used only when you click Publish: Colony pushes main from the base’s git server and opens the pull request itself. Agents never see this token.
          It is stored encrypted on this machine and is never sent back to the browser.
        </p>
        <p className="m-0 text-xs leading-normal text-ink-dim">
          Use a <a href={TOKEN_URL} target="_blank" rel="noreferrer" className="font-semibold text-ink">fine-grained token ↗</a> limited to the repos you publish to, with
          <b className="font-semibold text-ink-soft"> Contents: read and write</b> and <b className="font-semibold text-ink-soft">Pull requests: read and write</b>.
        </p>
        {live ? (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (token.trim()) void run('save') }}>
            <Field label={st?.configured ? 'Replace token' : 'Token'}>
              <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)}
                placeholder={st?.configured ? 'Stored · ••••••••' : 'github_pat_…'} aria-label="GitHub token" className={cx(inputCls, 'w-80 font-mono text-[13px]')} />
            </Field>
            <Button variant="primary" type="submit" disabled={!token.trim() || !!busy}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
            <Button onClick={() => void run('test')} disabled={!!busy || !st?.configured}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
            {st?.configured && <Button variant="danger" onClick={() => void run('remove')} disabled={!!busy}>{busy === 'remove' ? 'Removing…' : 'Remove'}</Button>}
          </form>
        ) : (
          <div className="text-xs text-ink-dim">Connect to a live control plane to add a token.</div>
        )}
        {note && <div className={cx('text-xs', note.ok ? 'text-st-done' : 'text-st-error')}>{note.ok ? '✓' : '✕'} {note.text}</div>}
      </section>
    </>
  )
}
