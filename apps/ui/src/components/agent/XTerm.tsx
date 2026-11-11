// Live Terminal tab: xterm.js on the agent's terminal WebSocket (see api/terminal.ts).
import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Agent } from '@/types/colony'
import type { TermStatus, TerminalSession } from '@/api/terminal'
import { cx } from '@/lib/util'

const BG = '#05070A' // the design's terminal well

/** Terminal palette from the design tokens (CSS variables from tokens/theme.css). */
function themeFromTokens(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(`--color-${name}`).trim() || fallback
  return {
    background: BG,
    foreground: v('ink-soft', '#C7CFDA'),
    cursor: v('you', '#F0B44C'),
    cursorAccent: BG,
    selectionBackground: v('line-strong', '#3A4452'),
    black: v('surface', '#151A21'),
    red: v('st-error', '#F2706A'),
    green: v('st-done', '#5CC98A'),
    yellow: v('st-you', '#F5B83D'),
    blue: v('st-run', '#5AA9F0'),
    magenta: v('st-think', '#A99BF5'),
    cyan: v('diff-add', '#8FE0B0'),
    white: v('ink-soft', '#C7CFDA'),
    brightBlack: v('ink-dim', '#8592A3'),
    brightRed: v('diff-del', '#F7A39E'),
    brightGreen: v('diff-add', '#8FE0B0'),
    brightYellow: v('you', '#F0B44C'),
    brightBlue: v('st-run', '#5AA9F0'),
    brightMagenta: '#C9C0FA',
    brightCyan: v('diff-add', '#8FE0B0'),
    brightWhite: v('ink', '#E6EAF0'),
  }
}

export function XTerm({ agent, session, interactive }: { agent: Agent; session: TerminalSession; interactive: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const interactiveRef = useRef(interactive)
  interactiveRef.current = interactive
  const [status, setStatus] = useState<TermStatus>(session.status)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      theme: themeFromTokens(),
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      disableStdin: !interactiveRef.current,
      allowProposedApi: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    try { fit.fit() } catch { /* not laid out yet */ }

    const unData = session.onData((d) => term.write(d))
    const unStatus = session.onStatus(setStatus)
    setStatus(session.status)
    session.ensure(term.cols, term.rows)

    const enc = new TextEncoder()
    const d1 = term.onData((d) => { if (interactiveRef.current) session.send(enc.encode(d)) })
    const d2 = term.onBinary((d) => { if (interactiveRef.current) session.send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)) })

    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        try { fit.fit(); session.resize(term.cols, term.rows) } catch { /* hidden */ }
      })
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect(); d1.dispose(); d2.dispose(); unData(); unStatus()
      termRef.current = null
      // xterm 5.5 schedules a viewport sync right after open(); disposing synchronously (StrictMode's
      // double mount, or a quick tab switch) makes that timer throw. Let it run first.
      setTimeout(() => { try { term.dispose() } catch { /* already gone */ } }, 0)
    }
  }, [session])

  useEffect(() => {
    const t = termRef.current
    if (!t) return
    t.options.disableStdin = !interactive
    if (interactive) t.focus()
  }, [interactive])

  const line = status.state === 'open'
    ? { cls: 'text-st-done', text: `● Connected · ${agent.container.name} · /workspace` }
    : status.state === 'closed'
      ? { cls: 'text-st-error', text: `✕ Closed · ${status.reason ?? 'session ended'}` }
      : { cls: 'text-st-run', text: `◌ Connecting to ${agent.container.name}…` }

  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-xs">
        <span className={cx('font-mono', line.cls)}>{line.text}</span>
        {status.state === 'closed' && (
          <button type="button" onClick={() => session.reconnect()} className="ml-auto rounded-sm border border-line px-2.5 py-1 text-xs text-ink">↻ Reconnect</button>
        )}
      </div>
      <div className={cx('h-[420px] overflow-hidden rounded-lg border p-2', interactive ? 'border-you/50' : 'border-line-soft')} style={{ background: BG }}>
        <div ref={host} className="h-full w-full" />
      </div>
      <p className="mt-2 text-xs text-ink-dim">{interactive
        ? `You are typing into the real shell. When you hand back, ${agent.callsign} gets a summary of what changed in the workspace.`
        : 'Read-only while the agent is in control. Press T to take over and type here.'}</p>
    </div>
  )
}
