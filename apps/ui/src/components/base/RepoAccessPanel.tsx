// "Use locally" (feedback #19): serve the base's repo read-only on 127.0.0.1 so the commander can
// fetch any agent branch into their own checkout. Fetch only: pushes are refused.
import { useEffect, useState } from 'react'
import type { Project } from '@/types/colony'
import { endpoints, type RepoAccess } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { useStore } from '@/store/store'

export function RepoAccessPanel({ project }: { project: Project }) {
  const { mode } = useStore()
  const [access, setAccess] = useState<RepoAccess | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(-1)

  useEffect(() => {
    if (mode !== 'live') return
    endpoints.repoAccess(project.id).then(setAccess, () => {})
  }, [project.id, mode])
  if (mode !== 'live') return null

  const run = async (fn: () => Promise<RepoAccess | null>) => {
    setBusy(true); setErr('')
    try { setAccess(await fn()) } catch (e) { setErr(errorMessage(e)) } finally { setBusy(false) }
  }
  const copy = (i: number, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(i); setTimeout(() => setCopied(-1), 1500) }, () => {})
  }

  return (
    <div className="mt-3 border-t border-line-soft pt-3 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <b className="text-[13px]">Use locally</b>
        <span className="text-ink-dim">fetch any branch into your own checkout · read-only</span>
      </div>
      {!access
        ? <button type="button" disabled={busy} onClick={() => void run(() => endpoints.openRepoAccess(project.id))} className="rounded-md border border-line px-2.5 py-1 text-ink-soft hover:border-line-strong disabled:opacity-50">Open repo on this machine</button>
        : (
          <div className="flex flex-col gap-1.5">
            <span className="text-ink-muted">Serving at <code className="font-mono text-ink">{access.url}</code> (this machine only; pushes are refused). In your local clone:</span>
            {access.commands.map((c, i) => (
              <div key={i} className="flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded-sm bg-well px-2 py-1 font-mono text-[11px] text-ink-soft">{c}</code>
                <button type="button" onClick={() => copy(i, c.split('    #')[0])} className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-ink-muted">{copied === i ? '✓' : 'Copy'}</button>
              </div>
            ))}
            <button type="button" disabled={busy} onClick={() => void run(async () => { await endpoints.closeRepoAccess(project.id); return null })} className="self-start rounded-md border border-line px-2.5 py-1 text-ink-soft disabled:opacity-50">Stop serving</button>
          </div>
        )}
      {err && <p className="m-0 mt-1.5 text-st-error">✕ {err}</p>}
    </div>
  )
}
