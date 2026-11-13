// A tiny, safe Markdown subset for quest briefs: headings, bullet / numbered lists, fenced code,
// paragraphs, and inline `code`, **bold**, *italic*. It builds React elements (never HTML strings),
// so nothing in a brief can inject markup. Links render as plain text.
import { Fragment, type ReactNode } from 'react'

export type MdBlock =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'code'; text: string }

export const isList = (b: MdBlock): b is Extract<MdBlock, { items: string[] }> => 'items' in b
/** Plain text of a block (list items joined with `sep`). */
export const blockText = (b: MdBlock, sep = ' ') => ('items' in b ? b.items.join(sep) : b.text)

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: MdBlock[] = []
  let para: string[] = []
  const flush = () => { if (para.length) { out.push({ t: 'p', text: para.join(' ') }); para = [] } }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) { flush(); continue }
    if (trimmed.startsWith('```')) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) code.push(lines[i])
      out.push({ t: 'code', text: code.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed)
    if (h) { flush(); out.push({ t: 'h', level: h[1].length, text: h[2] }); continue }
    const li = /^(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(trimmed)
    if (li) {
      flush()
      const kind = li[1] ? 'ul' : 'ol'
      const last = out[out.length - 1]
      if (last && last.t === kind) last.items.push(li[3])
      else out.push({ t: kind, items: [li[3]] })
      continue
    }
    // An indented line right after a list item continues that item.
    const last = out[out.length - 1]
    if (!para.length && /^\s{2,}/.test(line) && last && (last.t === 'ul' || last.t === 'ol')) {
      last.items[last.items.length - 1] += ' ' + trimmed
      continue
    }
    para.push(trimmed)
  }
  flush()
  return out
}

/** Inline: `code`, **bold** / __bold__, *italic* / _italic_, [text](url) → text. */
export function renderInline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\([^)\s]*\)/g
  let last = 0, n = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${key}-${n++}`
    if (m[2] !== undefined) out.push(<code key={k} className="rounded-xs bg-ground px-1 py-px font-mono text-[12px] text-ink">{m[2]}</code>)
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<b key={k} className="font-semibold text-ink">{renderInline(m[3] ?? m[4], k)}</b>)
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<em key={k}>{renderInline(m[5] ?? m[6], k)}</em>)
    else if (m[7] !== undefined) out.push(<Fragment key={k}>{renderInline(m[7], k)}</Fragment>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function MarkdownBlocks({ blocks }: { blocks: MdBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        const k = `b${i}`
        switch (b.t) {
          case 'h': return <h3 key={k} className={b.level <= 2 ? 'm-0 mt-3 text-label first:mt-0' : 'm-0 mt-2.5 text-[13px] font-semibold text-ink first:mt-0'}>{renderInline(b.text, k)}</h3>
          case 'p': return <p key={k} className="m-0 mt-1.5 leading-relaxed first:mt-0">{renderInline(b.text, k)}</p>
          case 'code': return <pre key={k} className="m-0 mt-1.5 overflow-x-auto rounded-md border border-line-soft bg-ground px-3 py-2 font-mono text-xs text-ink-muted">{b.text}</pre>
          case 'ul': case 'ol': {
            const L = b.t
            return (
              <L key={k} className={`m-0 mt-1.5 flex flex-col gap-1 pl-5 leading-relaxed first:mt-0 ${L === 'ul' ? 'list-disc' : 'list-decimal'} marker:text-ink-dim`}>
                {b.items.map((it, j) => <li key={j}>{renderInline(it, `${k}-${j}`)}</li>)}
              </L>
            )
          }
        }
      })}
    </>
  )
}

export function Markdown({ source }: { source: string }) {
  return <MarkdownBlocks blocks={parseMarkdown(source)} />
}
