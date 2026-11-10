// Global keyboard map from the design. Ignores keys while typing.
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/store/store'
import { isTypingTarget } from '@/lib/util'

export function useHotkeys() {
  const nav = useNavigate()
  const { state, dispatch } = useStore()
  const sRef = useRef(state)
  sRef.current = state
  const gPending = useRef(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = sRef.current
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); dispatch({ type: 'overlay', overlay: 'palette' }); return }
      if (e.key === 'Escape') {
        if (s.ui.overlay) dispatch({ type: 'overlay', overlay: null })
        else if (s.ui.inspectAgentId) dispatch({ type: 'inspect', id: undefined })
        else if (s.ui.selected.length) dispatch({ type: 'select', ids: [] })
        return
      }
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      const inspected = s.agents.find((a) => a.id === s.ui.inspectAgentId)
      if (inspected?.controller === 'you' && e.key.toLowerCase() !== 't') return // keys go to the agent while you drive

      const now = Date.now()
      if (gPending.current && now - gPending.current < 1200) {
        gPending.current = 0
        if (e.key === 'i') { nav('/inbox'); return }
        if (e.key === 'a') {
          const next = s.alerts.find((a) => !a.resolvedAt && a.severity !== 'heads_up')
          nav(next ? `/inbox#${next.id}` : '/inbox'); return
        }
      }
      if (e.key === 'g') { gPending.current = now; return }
      if (/^[1-9]$/.test(e.key)) { if (s.projects.some((p) => p.key === Number(e.key))) nav(`/base/${e.key}`); return }
      if (e.key === '0') { nav('/'); return }
      if (e.key === '?') { dispatch({ type: 'overlay', overlay: s.ui.overlay === 'shortcuts' ? null : 'shortcuts' }); return }
      if (e.key === ' ') {
        e.preventDefault()
        if (e.shiftKey) { dispatch({ type: 'pauseAll' }); return }
        const ids = s.ui.selected.length ? s.ui.selected : inspected ? [inspected.id] : []
        if (!ids.length) return
        const allPaused = ids.every((id) => s.agents.find((a) => a.id === id)?.status === 'paused')
        dispatch({ type: allPaused ? 'resume' : 'pause', ids })
        return
      }
      switch (e.key) {
        case 'r': nav('/roster'); break
        case 's': nav('/spawn'); break
        case 'n': nav('/new'); break
        case 'w': nav(location.pathname === '/ambient' ? '/' : '/ambient'); break
        case 't': if (inspected) dispatch({ type: inspected.controller === 'you' ? 'handBack' : 'takeControl', id: inspected.id }); break
        case 'M': dispatch({ type: 'mute' }); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch, nav])
}
