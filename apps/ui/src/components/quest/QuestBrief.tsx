// Quest brief, rendered for scanning (feedback #10): the Goal line up top, "Owns" as file chips,
// the rest as Markdown, and long briefs collapsed behind "Show more". Works for structured briefs
// (`Goal: …` / `## Goal`, `Owns: …` / `## Owns`) and for older one-paragraph prose briefs.
import { useState } from 'react'
import { MarkdownBlocks, blockText, isList, parseMarkdown, renderInline, type MdBlock } from '@/lib/markdown'

const B = '(?:\\*\\*|__)?'
const labelLine = (word: string) => new RegExp(`^\\s*(?:[-*+]\\s+)?${B}(?:${word})(?::${B}|${B}:)\\s*(.*)$`, 'i')
const GOAL_LINE = labelLine('goal')
const OWNS_LINE = labelLine('owns|owned files|file ownership')
const GOAL_HEAD = /^goal:?$/i
const OWNS_HEAD = /^(?:owns|ownership|owned files|files owned|file ownership)\b.*$/i
const OWNS_INLINE = /\s*(?:\*\*|__)?\bOwns(?::(?:\*\*|__)?|(?:\*\*|__)?:)\s*(.+?)(?:\.(?=\s+[A-Z(])|\.?\s*$)/

const chips = (s: string) => s.split(/\s*[,;]\s*|\s+and\s+/)
  .map((c) => c.trim().replace(/^`+|`+$/g, '').replace(/\.$/, '').trim())
  .filter(Boolean)

export function splitBrief(brief: string): { goal?: string; owns: string[]; blocks: MdBlock[] } {
  let goal: string | undefined
  const owns: string[] = []
  // 1. Label lines: "Goal: …" and "Owns: …" anywhere, on their own line.
  const kept: string[] = []
  for (const line of brief.replace(/\r\n?/g, '\n').split('\n')) {
    const g = !goal && GOAL_LINE.exec(line)
    if (g && g[1].trim()) { goal = g[1].trim(); continue }
    const o = OWNS_LINE.exec(line)
    if (o && o[1].trim()) { owns.push(...chips(o[1])); continue }
    kept.push(line)
  }
  // 2. Sections: "## Goal" and "## Owns" headings take the blocks under them.
  const blocks: MdBlock[] = []
  const all = parseMarkdown(kept.join('\n'))
  for (let i = 0; i < all.length; i++) {
    const b = all[i]
    const take = b.t === 'h' && ((!goal && GOAL_HEAD.test(b.text.trim())) ? 'goal' : OWNS_HEAD.test(b.text.trim()) ? 'owns' : null)
    if (!take) { blocks.push(b); continue }
    const body: MdBlock[] = []
    while (i + 1 < all.length && all[i + 1].t !== 'h') body.push(all[++i])
    if (take === 'goal') goal = body.map((x) => blockText(x, ' · ')).join(' ')
    else for (const x of body) owns.push(...(isList(x) ? x.items.flatMap(chips) : chips(blockText(x))))
  }
  // 3. Prose briefs: "… Owns: a, b. Read AGENTS.md …" inside a paragraph.
  const out = blocks.map((b) => {
    if (b.t !== 'p') return b
    const m = OWNS_INLINE.exec(b.text)
    if (!m) return b
    owns.push(...chips(m[1]))
    const text = (b.text.slice(0, m.index) + ' ' + b.text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim()
    return { ...b, text }
  }).filter((b) => b.t !== 'p' || b.text)
  return { goal, owns: [...new Set(owns)], blocks: out }
}

const LONG_CHARS = 700
const LONG_BLOCKS = 7

export function QuestBrief({ brief }: { brief: string }) {
  const [open, setOpen] = useState(false)
  if (!brief.trim()) return <p className="m-0 mb-3 leading-relaxed text-ink-soft">No brief yet. The Orchestrator writes one when it assigns the quest.</p>
  const { goal, owns, blocks } = splitBrief(brief)
  const bodyChars = blocks.reduce((n, b) => n + blockText(b).length, 0)
  const long = bodyChars > LONG_CHARS || blocks.length > LONG_BLOCKS
  const collapsed = long && !open
  return (
    <div className="mb-3 flex flex-col gap-3 text-[13px] text-ink-soft">
      {goal && (
        <div className="rounded-md border-l-2 border-you bg-ground/60 px-3 py-2">
          <div className="text-label">Goal</div>
          <div className="mt-0.5 text-[15px] font-medium leading-snug text-ink">{renderInline(goal, 'goal')}</div>
        </div>
      )}
      {owns.length > 0 && (
        <div>
          <div className="text-label mb-1.5">Owns</div>
          <ul aria-label="Files this quest owns" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {owns.map((f) => (
              <li key={f} title={f} className="max-w-full truncate rounded-sm border border-line bg-ground px-1.5 py-0.5 font-mono text-[11.5px] text-ink">{f}</li>
            ))}
          </ul>
        </div>
      )}
      {blocks.length > 0 && (
        <div>
          <div className={collapsed ? 'relative max-h-[200px] overflow-hidden' : undefined}>
            <MarkdownBlocks blocks={blocks} />
            {collapsed && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-surface to-transparent" />}
          </div>
          {long && (
            <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="mt-1.5 text-xs font-semibold text-you">
              {open ? 'Show less ↑' : 'Show more ↓'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
