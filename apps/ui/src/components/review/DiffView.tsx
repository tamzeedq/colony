// Real diffs from GET /api/projects/:id/diff?branch=… rendered with the design's diff styling.
import { Fragment, useCallback, useEffect, useState } from 'react'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { parseUnifiedDiff, type DiffFile } from '@/lib/diff'
import { cx } from '@/lib/util'
import { secretFileRisk, secretKinds } from '@colony/shared'

/** Secret flags for Merge Review (feedback item 6): the file itself (.env*, *.pem, *secret*…)
 *  and added lines with secret-shaped strings, by line index. */
export interface SecretFlags { file?: { level: 'block' | 'warn'; reason: string }; lines: Map<number, string> }
export function secretFlags(file: DiffFile): SecretFlags {
  const lines = new Map<number, string>()
  const deleted = file.added === 0 && file.removed > 0 && file.lines.every((l) => l.kind !== 'add' && l.kind !== 'ctx')
  file.lines.forEach((l, i) => { if (l.kind === 'add') { const k = secretKinds(l.text); if (k.length) lines.set(i, k.join(', ')) } })
  return { file: deleted ? undefined : secretFileRisk(file.path), lines }
}
export const isFlagged = (f: SecretFlags) => f.file?.level === 'block' || f.lines.size > 0

export type DiffState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; error: string } | { status: 'ok'; files: DiffFile[] }

export function useDiff(projectId?: string, branch?: string, base?: string) {
  const [st, setSt] = useState<DiffState>({ status: 'idle' })
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!projectId || !branch) { setSt({ status: 'idle' }); return }
    let live = true
    setSt({ status: 'loading' })
    endpoints.diff(projectId, branch, base).then(
      (text) => { if (live) setSt({ status: 'ok', files: parseUnifiedDiff(text) }) },
      (e) => { if (live) setSt({ status: 'error', error: errorMessage(e) }) },
    )
    return () => { live = false }
  }, [projectId, branch, base, n])
  const reload = useCallback(() => setN((x) => x + 1), [])
  return { ...st, reload } as DiffState & { reload: () => void }
}

/** File list row, shared by the Changes tab and Merge review. */
export function DiffFileButton({ file, selected, prefix, onClick, flags }: { file: DiffFile; selected: boolean; prefix?: string; onClick: () => void; flags?: SecretFlags }) {
  const bad = flags && isFlagged(flags)
  const warn = !bad && flags?.file?.level === 'warn'
  const why = flags ? [flags.file?.reason, flags.lines.size ? `${flags.lines.size} line${flags.lines.size === 1 ? '' : 's'} with secret-shaped strings` : ''].filter(Boolean).join(' · ') : ''
  return (
    <button type="button" onClick={onClick} title={why || undefined} className={cx('flex w-full justify-between gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-xs', selected ? 'bg-raised' : 'hover:bg-surface', bad && 'text-st-error', warn && 'text-st-blocked')}>
      <span className="truncate">{bad ? '⚠ ' : warn ? '▲ ' : ''}{prefix}{file.path}</span><span className="shrink-0"><span className="text-st-done">+{file.added}</span> <span className="text-st-error">−{file.removed}</span></span>
    </button>
  )
}

/** Compact diff (Inspector · Changes). */
export function CompactDiff({ file }: { file: DiffFile }) {
  return (
    <pre className="m-0 min-w-0 flex-[3_1_380px] overflow-x-auto rounded-md border border-line-soft bg-well py-2.5 font-mono text-xs leading-[1.7]">
      {file.lines.map((l, i) => (
        <span key={i} className={cx('block px-3',
          l.kind === 'add' && 'bg-st-done/10 text-diff-add', l.kind === 'del' && 'bg-st-error/10 text-diff-del',
          l.kind === 'ctx' && 'text-ink-muted', (l.kind === 'hunk' || l.kind === 'meta') && 'text-ink-dim')}>
          {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'ctx' ? ' ' : ''}{l.text}
        </span>
      ))}
      {!file.lines.length && <span className="block px-3 text-ink-dim">No textual changes (mode or rename only)</span>}
    </pre>
  )
}

/** Merge review diff: unified with line numbers, or split old | new. */
export function ReviewDiff({ file, view, flags }: { file: DiffFile; view: 'unified' | 'split'; flags?: SecretFlags }) {
  const secret = (i: number) => flags?.lines.get(i)
  const banner = flags && (flags.file || flags.lines.size > 0) && (
    <div role="alert" className={cx('mb-2.5 rounded-md border px-3 py-2 text-xs', isFlagged(flags) ? 'border-st-error/60 bg-st-error/10 text-st-error' : 'border-st-blocked/50 bg-st-blocked/10 text-st-blocked')}>
      ⚠ {flags.file ? `This file looks like a secret: ${flags.file.reason}.` : ''} {flags.lines.size ? `${flags.lines.size} added line${flags.lines.size === 1 ? '' : 's'} with secret-shaped strings (marked below).` : ''} Keep values in env vars or .env.local, not in the repo.
    </div>
  )
  if (view === 'split') {
    return (
      <>{banner}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line-soft bg-line-soft font-mono text-[12.5px] leading-[1.75]">
        {file.lines.map((l, i) => l.kind === 'meta' ? null : (
          <Fragment key={i}>
            {l.kind === 'hunk'
              ? <div className="col-span-2 bg-well px-2.5 text-ink-dim">{l.text}</div>
              : <>
                  <div className={cx('whitespace-pre px-2.5', l.kind === 'del' ? 'bg-st-error/8 text-diff-del' : l.kind === 'ctx' ? 'bg-well text-ink-muted' : 'bg-well')}>{l.kind === 'add' ? ' ' : l.text || ' '}</div>
                  <div title={secret(i)} className={cx('whitespace-pre px-2.5', secret(i) ? 'bg-st-error/20 text-st-error outline outline-1 outline-st-error/70' : l.kind === 'add' ? 'bg-st-done/8 text-diff-add' : l.kind === 'ctx' ? 'bg-well text-ink-muted' : 'bg-well')}>{l.kind === 'del' ? ' ' : l.text || ' '}</div>
                </>}
          </Fragment>
        ))}
      </div>
      </>
    )
  }
  return (
    <>{banner}
    <div className="overflow-hidden rounded-lg border border-line-soft bg-well font-mono text-[12.5px] leading-[1.75]">
      {file.lines.map((l, i) => (
        <div key={i} title={secret(i) ? `Secret-shaped: ${secret(i)}` : undefined} className={cx('flex', secret(i) ? 'bg-st-error/20 outline outline-1 outline-st-error/70' : l.kind === 'add' && 'bg-st-done/8', l.kind === 'del' && 'bg-st-error/8')}>
          <span className="w-11 shrink-0 select-none pr-2.5 text-right text-[#56606E]">{l.kind === 'del' ? l.oldNo : l.newNo ?? ''}</span>
          <span className={cx('w-4 shrink-0', l.kind === 'add' ? 'text-diff-add' : l.kind === 'del' ? 'text-diff-del' : 'text-ink-muted')}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
          <span className={cx('whitespace-pre', l.kind === 'add' ? 'text-diff-add' : l.kind === 'del' ? 'text-diff-del' : (l.kind === 'hunk' || l.kind === 'meta') ? 'text-ink-dim' : 'text-ink-muted')}>{l.text}</span>
        </div>
      ))}
      {!file.lines.length && <div className="px-3 text-ink-dim">No textual changes (mode or rename only)</div>}
    </div>
    </>
  )
}
