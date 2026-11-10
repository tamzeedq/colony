// Real-time without visual chaos: buffer incoming events, render at most `hz` times a second,
// collapse bursts of the same kind from the same agent, and hold the view still while the
// user is hovering or scrolled up (showing "N new events" instead).
import { useEffect, useRef, useState, useCallback } from 'react'
import type { ActivityEvent } from '@/types/colony'

export interface FeedItem extends ActivityEvent {
  groupCount?: number         // >1 when several same-kind events were collapsed ("Read 6 files")
}

interface Options {
  hz?: number                 // default 2
  groupWithinMs?: number      // default 1500
  max?: number                // keep the last N rows, default 300
  initial?: ActivityEvent[]
  filter?: (e: ActivityEvent) => boolean
}

export function useThrottledStream(subscribe: (onEvent: (e: ActivityEvent) => void) => () => void, opts: Options = {}) {
  const { hz = 2, groupWithinMs = 1500, max = 300, initial = [], filter } = opts
  const buffer = useRef<ActivityEvent[]>([])
  const filterRef = useRef(filter)
  filterRef.current = filter
  const [items, setItems] = useState<FeedItem[]>(() => (filter ? initial.filter(filter) : initial))
  const [held, setHeld] = useState(false)
  const [pending, setPending] = useState(0)
  const heldRef = useRef(false)
  heldRef.current = held

  useEffect(() => subscribe((e) => { if (!filterRef.current || filterRef.current(e)) buffer.current.push(e) }), [subscribe])

  useEffect(() => {
    const id = setInterval(() => {
      if (buffer.current.length === 0) return
      if (heldRef.current) { setPending(buffer.current.length); return }
      const incoming = buffer.current.splice(0)
      setPending(0)
      setItems((prev) => {
        const next = [...prev]
        for (const e of incoming) {
          const last = next[next.length - 1]
          const groupable = e.kind === 'tool' || e.kind === 'edit'
          if (groupable && last && last.kind === e.kind && last.agentId === e.agentId &&
              Date.parse(e.at) - Date.parse(last.at) < groupWithinMs) {
            next[next.length - 1] = { ...last, at: e.at, text: e.text, groupCount: (last.groupCount ?? 1) + 1 }
          } else {
            next.push(e)
          }
        }
        return next.slice(-max)
      })
    }, 1000 / hz)
    return () => clearInterval(id)
  }, [hz, groupWithinMs, max])

  const hold = useCallback(() => setHeld(true), [])
  const release = useCallback(() => setHeld(false), [])
  return { items, pending, held, hold, release }
}
