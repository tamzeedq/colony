// Real diffs from GET /api/projects/:id/diff?branch=… rendered with the design's diff styling.
import { Fragment, useCallback, useEffect, useState } from 'react'
import { endpoints } from '@/api/endpoints'
import { errorMessage } from '@/api/client'
import { parseUnifiedDiff, type DiffFile } from '@/lib/diff'
import { cx } from '@/lib/util'

export type DiffState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; error: string } | { status: 'ok'; files: DiffFile[] }

export function useDiff(projectId?: string, branch?: string) {
  const [st, setSt] = useState<DiffState>({ status: 'idle' })
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!projectId || !branch) { setSt({ status: 'idle' }); return }
    let live = true
    setSt({ status: 'loading' })
    endpoints.diff(projectId, branch).then(
      (text) => { if (live) setSt({ status: 'ok', files: parseUnifiedDiff(text) }) },
      (e) => { if (live) setSt({ status: 'error', error: errorMessage(e) }) },
    )
    return () => { live = false }
  }, [projectId, branch, n])
  const reload = useCallback(() => setN((x) => x + 1), [])
  return { ...st, reload } as DiffState & { reload: () => void }
}

/** File list row, shared by the Changes tab and Merge review. */
export function DiffFileButton({ file, selected, prefix, onClick }: { file: DiffFile; selected: boolean; prefix?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cx('flex w-full justify-between gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-xs', selected ? 'bg-raised' : 'hover:bg-surface')}>
      <span className="truncate">{prefix}{file.path}</span><span className="shrink-0"><span className="text-st-done">+{file.added}</span> <span className="text-st-error">−{file.removed}</span></span>
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
export function ReviewDiff({ file, view }: { file: DiffFile; view: 'unified' | 'split' }) {
  if (view === 'split') {
    return (
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line-soft bg-line-soft font-mono text-[12.5px] leading-[1.75]">
        {file.lines.filter((l) => l.kind !== 'meta').map((l, i) => (
          <Fragment key={i}>
            {l.kind === 'hunk'
              ? <div className="col-span-2 bg-well px-2.5 text-ink-dim">{l.text}</div>
              : <>
                  <div className={cx('whitespace-pre px-2.5', l.kind === 'del' ? 'bg-st-error/8 text-diff-del' : l.kind === 'ctx' ? 'bg-well text-ink-muted' : 'bg-well')}>{l.kind === 'add' ? ' ' : l.text || ' '}</div>
                  <div className={cx('whitespace-pre px-2.5', l.kind === 'add' ? 'bg-st-done/8 text-diff-add' : l.kind === 'ctx' ? 'bg-well text-ink-muted' : 'bg-well')}>{l.kind === 'del' ? ' ' : l.text || ' '}</div>
                </>}
          </Fragment>
        ))}
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line-soft bg-well font-mono text-[12.5px] leading-[1.75]">
      {file.lines.map((l, i) => (
        <div key={i} className={cx('flex', l.kind === 'add' && 'bg-st-done/8', l.kind === 'del' && 'bg-st-error/8')}>
          <span className="w-11 shrink-0 select-none pr-2.5 text-right text-[#56606E]">{l.kind === 'del' ? l.oldNo : l.newNo ?? ''}</span>
          <span className={cx('w-4 shrink-0', l.kind === 'add' ? 'text-diff-add' : l.kind === 'del' ? 'text-diff-del' : 'text-ink-muted')}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
          <span className={cx('whitespace-pre', l.kind === 'add' ? 'text-diff-add' : l.kind === 'del' ? 'text-diff-del' : (l.kind === 'hunk' || l.kind === 'meta') ? 'text-ink-dim' : 'text-ink-muted')}>{l.text}</span>
        </div>
      ))}
      {!file.lines.length && <div className="px-3 text-ink-dim">No textual changes (mode or rename only)</div>}
    </div>
  )
}
