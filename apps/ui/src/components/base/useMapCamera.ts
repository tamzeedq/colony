// Base map camera: one translate + scale shared by the Pixi stage and the HTML station overlay.
// Drag on empty map pans, the wheel zooms (0.6×–1.8×) around the cursor, double-click on empty
// map refits. `easeTo` animates the camera (Follow activity). The camera lives in a ref and is
// applied imperatively, so panning never re-renders React.
import { useCallback, useEffect, useRef } from 'react'
import type { Camera, Point } from './MapScene'

export const MIN_ZOOM = 0.6
export const MAX_ZOOM = 1.8
const FOLLOW_MS = 600

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const easeStandard = (t: number) => 1 - Math.pow(1 - t, 3)

/** Things inside the map that must keep their own pointer behaviour. */
const INTERACTIVE = 'button, a, input, select, textarea, label, [data-map-control]'

interface Options {
  enabled: boolean
  world: { w: number; h: number }
  /** Called with every camera change (the Pixi stage + the overlay transform). */
  apply: (cam: Camera) => void
  /** A manual pan or zoom happened (turns Follow off). */
  onManual?: () => void
}

export function useMapCamera({ enabled, world, apply, onManual }: Options) {
  const hostRef = useRef<HTMLElement | null>(null)
  const cam = useRef<Camera>({ x: 0, y: 0, scale: 1 })
  const size = useRef({ w: 0, h: 0 })
  const dirty = useRef(false) // moved away from the fitted view
  const anim = useRef<number | null>(null)
  const applyRef = useRef(apply)
  applyRef.current = apply
  const manualRef = useRef(onManual)
  manualRef.current = onManual

  const set = useCallback((c: Camera) => { cam.current = c; applyRef.current(c) }, [])
  const stopAnim = () => { if (anim.current != null) cancelAnimationFrame(anim.current); anim.current = null }

  const fitCamera = useCallback((): Camera => {
    const { w, h } = size.current
    const scale = clamp(Math.min(w / world.w, h / world.h, 1), MIN_ZOOM, 1)
    return { x: (w - world.w * scale) / 2, y: (h - world.h * scale) / 2, scale }
  }, [world.w, world.h])

  const fit = useCallback(() => { stopAnim(); dirty.current = false; set(fitCamera()) }, [fitCamera, set])

  /** Ease so that world point `p` sits at the centre of the view (current zoom). */
  const easeTo = useCallback((p: Point) => {
    stopAnim()
    const from = { ...cam.current }
    const { w, h } = size.current
    const to = { x: w / 2 - p.x * from.scale, y: h / 2 - p.y * from.scale, scale: from.scale }
    if (Math.abs(to.x - from.x) < 1 && Math.abs(to.y - from.y) < 1) return
    dirty.current = true
    const t0 = performance.now()
    const step = (now: number) => {
      const t = easeStandard(Math.min(1, (now - t0) / FOLLOW_MS))
      set({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, scale: from.scale })
      anim.current = t < 1 ? requestAnimationFrame(step) : null
    }
    anim.current = requestAnimationFrame(step)
  }, [set])

  /** The map container resized: refit unless the commander moved the camera. */
  const setSize = useCallback((w: number, h: number) => {
    size.current = { w, h }
    if (!dirty.current) set(fitCamera())
    else applyRef.current(cam.current)
  }, [fitCamera, set])

  // Pointer + wheel handlers on the map element.
  useEffect(() => {
    const el = hostRef.current
    if (!enabled || !el) return
    let drag: { id: number; sx: number; sy: number; cx: number; cy: number; moved: boolean } | null = null

    const manual = () => { stopAnim(); dirty.current = true; manualRef.current?.() }

    const down = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest(INTERACTIVE)) return
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false }
    }
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < 3) return
        drag.moved = true
        el.setPointerCapture(e.pointerId)
        el.dataset.dragging = 'true'
        manual()
      }
      set({ x: drag.cx + dx, y: drag.cy + dy, scale: cam.current.scale })
    }
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      if (drag.moved && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      delete el.dataset.dragging
      drag = null
    }
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('[data-map-control]')) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left, my = e.clientY - r.top
      const c = cam.current
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1
      const scale = clamp(c.scale * Math.exp(-e.deltaY * unit * 0.0015), MIN_ZOOM, MAX_ZOOM)
      if (scale === c.scale) return
      manual()
      const wx = (mx - c.x) / c.scale, wy = (my - c.y) / c.scale
      set({ x: mx - wx * scale, y: my - wy * scale, scale })
    }
    const dbl = (e: MouseEvent) => {
      if ((e.target as Element).closest(INTERACTIVE)) return
      manualRef.current?.()
      fit()
    }

    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('dblclick', dbl)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('dblclick', dbl)
      delete el.dataset.dragging
    }
  }, [enabled, fit, set])

  useEffect(() => () => stopAnim(), [])

  return { hostRef, cam, fit, easeTo, setSize }
}
