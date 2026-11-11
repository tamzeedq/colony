// Minimal unified-diff parser for `git diff` text (GET /api/projects/:id/diff).

export interface DiffLine { kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta'; text: string; oldNo?: number; newNo?: number }
export interface DiffFile { path: string; oldPath?: string; added: number; removed: number; binary: boolean; lines: DiffLine[] }

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let f: DiffFile | null = null
  let oldNo = 0, newNo = 0
  const start = (path: string, oldPath?: string): DiffFile => {
    const nf: DiffFile = { path, oldPath, added: 0, removed: 0, binary: false, lines: [] }
    files.push(nf)
    return nf
  }
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
      f = start(m ? m[2] : raw.slice(11), m && m[1] !== m[2] ? m[1] : undefined)
      continue
    }
    if (!f) {
      // Diff without `diff --git` headers (plain `---/+++`).
      if (raw.startsWith('--- ')) f = start('')
      else continue
    }
    const cur: DiffFile = f
    if (raw.startsWith('+++ ')) { const p = raw.slice(4).replace(/^b\//, ''); if (p !== '/dev/null') cur.path = p; continue }
    if (raw.startsWith('--- ')) { const p = raw.slice(4).replace(/^a\//, ''); if (!cur.path && p !== '/dev/null') cur.path = p; continue }
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      oldNo = m ? Number(m[1]) : 0
      newNo = m ? Number(m[2]) : 0
      cur.lines.push({ kind: 'hunk', text: raw })
      continue
    }
    if (raw.startsWith('Binary files')) { cur.binary = true; cur.lines.push({ kind: 'meta', text: raw }); continue }
    if (!cur.lines.length) continue // index / mode / rename headers before the first hunk
    if (raw.startsWith('+')) { cur.added++; cur.lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ }); continue }
    if (raw.startsWith('-')) { cur.removed++; cur.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ }); continue }
    if (raw.startsWith('\\')) { cur.lines.push({ kind: 'meta', text: raw }); continue }
    if (raw === '') continue
    cur.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
  }
  return files.filter((x) => x.path)
}

export const diffTotals = (files: DiffFile[]) => files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 })
