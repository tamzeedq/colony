// Base → Infra: where merged work goes on GitHub (docs/phase6.md "GitHub").
// Live mode: repo / base / mode form, "Publish to GitHub" (push mode asks first, since it moves
// the remote base branch), and the last publish. Mock mode is a read-only placeholder.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '@/store/store'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { Segmented, inputCls } from '@/components/ui/controls'
import { ago, cx } from '@/lib/util'
import type { GithubConfig, GithubTokenStatus, Project } from '@/types/colony'

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/
const MODES: { id: GithubConfig['mode']; label: string }[] = [{ id: 'pr', label: 'Pull request' }, { id: 'push', label: 'Push' }]

export function GithubPanel({ project }: { project: Project }) {
  const { mode, dispatch } = useStore()
  const live = mode === 'live'
  const gh = project.github
  const [repo, setRepo] = useState(gh?.repo ?? '')
  const [base, setBase] = useState(gh?.base ?? 'main')
  const [pubMode, setPubMode] = useState<GithubConfig['mode']>(gh?.mode ?? 'pr')
  const [token, setToken] = useState<GithubTokenStatus | null>(null)
  const [busy, setBusy] = useState<'' | 'save' | 'publish'>('')
  const [confirmPush, setConfirmPush] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  // Follow the server's config when it actually changes (snapshots replace the object each time).
  const serverKey = `${project.id}|${gh?.repo ?? ''}|${gh?.base ?? 'main'}|${gh?.mode ?? 'pr'}`
  const synced = useRef(serverKey)
  useEffect(() => {
    if (synced.current === serverKey) return
    synced.current = serverKey
    setRepo(gh?.repo ?? ''); setBase(gh?.base ?? 'main'); setPubMode(gh?.mode ?? 'pr')
  }, [serverKey, gh])
  useEffect(() => { setNote(null); setConfirmPush(false) }, [project.id])

  useEffect(() => {
    if (!live) return
    let on = true
    endpoints.github().then((s) => { if (on) setToken(s) }, () => { if (on) setToken(null) })
    return () => { on = false }
  }, [live])

  const repoOk = REPO_RE.test(repo.trim())
  const dirty = repo.trim() !== (gh?.repo ?? '') || base.trim() !== (gh?.base ?? 'main') || pubMode !== (gh?.mode ?? 'pr')
  const canPublish = !!gh?.repo && !dirty && !!token?.configured && !busy

  const save = async () => {
    setBusy('save'); setNote(null)
    try {
      const p = await endpoints.patchProjectGithub(project.id, { repo: repo.trim(), base: base.trim() || 'main', mode: pubMode })
      if (p?.id) dispatch({ type: 'upsertProject', project: p })
      setNote({ ok: true, text: 'Saved' })
    } catch (e) {
      setNote({ ok: false, text: `Save failed · ${errorMessage(e)}` })
    } finally {
      setBusy('')
    }
  }

  const publish = async () => {
    setBusy('publish'); setNote(null); setConfirmPush(false)
    try {
      const r = await endpoints.publishGithub(project.id)
      setNote({ ok: true, text: r.url ? `Opened a pull request from ${r.branch}` : `Pushed ${r.sha.slice(0, 7)} to ${r.branch}` })
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e) })
    } finally {
      setBusy('')
    }
  }

  const last = gh?.lastPublish
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-semibold">GitHub</span>
        {gh?.repo && <span className="min-w-0 truncate font-mono text-[11px] text-ink-dim">{gh.repo} · {gh.base} · {gh.mode === 'push' ? 'push' : 'PR'}</span>}
      </div>

      {!live && (
        <div className="text-xs text-ink-dim">
          {gh?.repo ? 'Publishing merged work to GitHub works in live mode.' : 'Not connected. In live mode, set a repo here and publish merged work with one click.'}
        </div>
      )}

      {live && (
        <>
          {token && !token.configured && (
            <div className="mb-2 text-xs text-ink-dim">No GitHub token yet. <Link to="/settings/github" className="font-semibold text-ink">Add one in Settings → GitHub</Link></div>
          )}
          {token?.status === 'error' && <div className="mb-2 text-xs text-st-error">✕ The GitHub token failed its last test. <Link to="/settings/github" className="font-semibold">Check it</Link></div>}
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (dirty && repoOk) void save() }}>
            <label className="flex min-w-0 flex-[2_1_160px] flex-col gap-1 text-[11px] text-ink-dim">
              Repo
              <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" spellCheck={false} aria-label="GitHub repository (owner/name)"
                className={cx(inputCls, 'px-2 py-1 font-mono text-xs', repo.trim() && !repoOk && 'border-st-error/60')} />
            </label>
            <label className="flex w-24 flex-col gap-1 text-[11px] text-ink-dim">
              Base
              <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="main" spellCheck={false} aria-label="Base branch" className={cx(inputCls, 'px-2 py-1 font-mono text-xs')} />
            </label>
            <Segmented label="Publish mode" options={MODES} value={pubMode} onChange={setPubMode} />
            {dirty && <button type="submit" disabled={!repoOk || !!busy} className="rounded-md border border-line bg-raised px-2.5 py-1 text-xs font-semibold text-ink disabled:opacity-50">{busy === 'save' ? 'Saving…' : 'Save'}</button>}
          </form>
          <div className="mt-1.5 text-[11px] text-ink-dim">
            {pubMode === 'pr' ? `Pushes Colony's main to a new colony/<date> branch and opens a PR against ${base.trim() || 'main'}.` : `Fast-forwards ${base.trim() || 'main'} on GitHub to Colony's main. Refused if GitHub has commits Colony doesn't.`}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line-soft pt-2.5">
            <button type="button" disabled={!canPublish}
              onClick={() => (gh?.mode === 'push' ? setConfirmPush(true) : void publish())}
              title={!gh?.repo ? 'Set and save a repo first' : dirty ? 'Save your changes first' : !token?.configured ? 'Add a GitHub token in Settings first' : undefined}
              className="rounded-md border border-transparent bg-ink px-2.5 py-1 text-xs font-semibold text-ground transition duration-[80ms] ease-standard hover:brightness-110 disabled:opacity-50">
              {busy === 'publish' ? 'Publishing…' : '↑ Publish to GitHub'}
            </button>
            {last && (
              <span className="min-w-0 truncate text-xs text-ink-dim">
                Last {ago(last.at)} ago ·{' '}
                {last.url
                  ? <a href={last.url} target="_blank" rel="noreferrer" className="font-semibold text-ink no-underline hover:underline">{last.url.replace(/^https:\/\/github\.com\//, '')} ↗</a>
                  : <span className="font-mono">{last.sha.slice(0, 7)} → {last.branch}</span>}
              </span>
            )}
          </div>
          {confirmPush && gh && (
            <div role="alertdialog" aria-label="Confirm push" className="mt-2 rounded-md border border-line-strong px-2.5 py-2 text-xs">
              Push Colony’s main to <span className="font-mono">{gh.repo}:{gh.base}</span>? Only a fast-forward is allowed; nothing on GitHub is overwritten.
              <div className="mt-1.5 flex gap-1.5">
                <button type="button" onClick={() => void publish()} className="rounded-xs bg-ink px-2 py-0.5 font-semibold text-ground">Push</button>
                <button type="button" onClick={() => setConfirmPush(false)} className="px-1 text-ink-soft">Cancel</button>
              </div>
            </div>
          )}
          {note && <div role={note.ok ? 'status' : 'alert'} className={cx('mt-2 whitespace-pre-wrap break-words text-xs', note.ok ? 'text-st-done' : 'text-st-error')}>{note.ok ? '✓' : '✕'} {note.text}</div>}
        </>
      )}
    </div>
  )
}
