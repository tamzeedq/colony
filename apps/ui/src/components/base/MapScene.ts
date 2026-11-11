// The Pixi layer under the base map's HTML stations (docs/phase5.md "Base map canvas").
// It draws the dot grid, HQ → worker links (solid when idle, marching dashes when live),
// handoff pulses and the spawn ghost. World coordinates are the 960×520 layout in BaseMap;
// the camera (translate + scale) is shared with the HTML overlay.
//
// One instance per mounted map. `init` is async (Pixi v8); `destroy` may be called at any time,
// including while `init` is still pending, and cleans up once it settles.
import { Application, Color, Container, Graphics, Texture, TilingSprite } from 'pixi.js'
import type { AgentStatus } from '@/types/colony'
import { STATUS } from '@/design/status'

export interface Camera { x: number; y: number; scale: number }
export interface Point { x: number; y: number }
/** x/y: the link end (station anchor). box: the card's rect in world space (for the ghost). */
export interface SceneStation { id: string; x: number; y: number; status: AgentStatus; box: { x: number; y: number; w: number; h: number } }
export interface SceneModel { hub: Point; workers: SceneStation[] }

const LIVE = new Set<AgentStatus>(['running', 'editing', 'thinking', 'booting'])
const GRID = 22                 // px between dots, same as the CSS fallback
const DASH = 5, GAP = 7         // the `link-live` utility: 5px dash, 7px gap
const MARCH_PX_PER_S = 24 / 1.4 // `march` keyframes: 24px per 1.4 s
const PULSE_LEG_MS = 1800       // a pulse crosses one link in 1.8 s
const BREATHE_MS = 1200         // spawn ghost pulse (the `breathe` loop)

const FALLBACK: Record<string, string> = {
  'line': '#2A333F', 'line-soft': '#222A35', 'st-idle': '#8592A3', 'st-think': '#A99BF5', 'st-run': '#5AA9F0',
  'st-you': '#F5B83D', 'st-blocked': '#C79A5B', 'st-error': '#F2706A', 'st-paused': '#B8C1CC', 'st-done': '#5CC98A',
}

/** Theme colours from the CSS variables on :root, so the canvas follows the tokens. */
function readColors(): Record<string, number> {
  const css = getComputedStyle(document.documentElement)
  const out: Record<string, number> = {}
  for (const name of Object.keys(FALLBACK)) {
    const raw = css.getPropertyValue(`--color-${name}`).trim() || FALLBACK[name]
    try { out[name] = new Color(raw).toNumber() } catch { out[name] = new Color(FALLBACK[name]).toNumber() }
  }
  return out
}

interface Pulse { path: Point[]; start: number }

export class MapScene {
  private app: Application | null = null
  private initPromise: Promise<boolean> | null = null
  private destroyed = false
  private world = new Container()
  private grid: TilingSprite | null = null
  private links = new Graphics()
  private ghosts = new Graphics()
  private pulseG = new Graphics()
  private model: SceneModel = { hub: { x: 0, y: 0 }, workers: [] }
  private pulses: Pulse[] = []
  private colors: Record<string, number> = {}
  private camera: Camera = { x: 0, y: 0, scale: 1 }
  private onVisibility = () => {
    if (!this.app) return
    if (document.hidden) this.app.ticker.stop()
    else this.app.ticker.start()
  }

  /** Resolves false when Pixi cannot start (no WebGL) or the scene was destroyed meanwhile. */
  init(host: HTMLElement, width: number, height: number): Promise<boolean> {
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      const app = new Application()
      try {
        await app.init({
          width: Math.max(1, width), height: Math.max(1, height), backgroundAlpha: 0, antialias: true,
          resolution: window.devicePixelRatio || 1, autoDensity: true, preference: 'webgl',
        })
      } catch {
        try { app.destroy(true) } catch { /* partially initialised */ }
        return false
      }
      if (this.destroyed) { app.destroy(true, { children: true, texture: true }); return false }
      this.app = app
      this.colors = readColors()
      const canvas = app.canvas
      canvas.style.position = 'absolute'
      canvas.style.inset = '0'
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.setAttribute('aria-hidden', 'true')
      host.appendChild(canvas)

      this.grid = new TilingSprite({ texture: this.dotTexture(), width: app.screen.width, height: app.screen.height })
      app.stage.addChild(this.grid)
      this.world.addChild(this.links, this.ghosts, this.pulseG)
      app.stage.addChild(this.world)
      this.applyCamera()
      app.ticker.add(() => this.frame(performance.now()))
      document.addEventListener('visibilitychange', this.onVisibility)
      this.onVisibility()
      return true
    })()
    return this.initPromise
  }

  /** A 2× dot tile, scaled down by the camera, so the grid stays sharp when zoomed in. */
  private dotTexture(): Texture {
    const c = document.createElement('canvas')
    c.width = c.height = GRID * 2
    const ctx = c.getContext('2d')
    if (ctx) {
      ctx.fillStyle = `#${(this.colors['line-soft'] ?? 0x222a35).toString(16).padStart(6, '0')}`
      ctx.beginPath()
      ctx.arc(GRID, GRID, 2, 0, Math.PI * 2)
      ctx.fill()
    }
    return Texture.from(c)
  }

  resize(width: number, height: number) {
    if (!this.app) return
    this.app.renderer.resize(Math.max(1, width), Math.max(1, height))
    if (this.grid) { this.grid.width = this.app.screen.width; this.grid.height = this.app.screen.height }
  }

  setCamera(cam: Camera) {
    this.camera = cam
    this.applyCamera()
  }

  private applyCamera() {
    const { x, y, scale } = this.camera
    this.world.position.set(x, y)
    this.world.scale.set(scale)
    if (this.grid) {
      // The tile is drawn at 2×; the dot sits in its centre, so offset by half a cell.
      this.grid.tileScale.set(scale / 2)
      this.grid.tilePosition.set(x - (GRID / 2) * scale, y - (GRID / 2) * scale)
    }
  }

  setModel(model: SceneModel) {
    this.model = model
    this.colors = readColors()
  }

  /** A dot travelling along `path` (world points), one link (1.8 s) per leg. */
  pulse(path: Point[]) {
    if (!this.app || path.length < 2) return
    this.pulses.push({ path, start: performance.now() })
    if (this.pulses.length > 40) this.pulses.splice(0, this.pulses.length - 40)
  }

  private color(status: AgentStatus) {
    return this.colors[STATUS[status].token] ?? this.colors['st-run']
  }

  private frame(now: number) {
    const { hub, workers } = this.model
    const march = ((now / 1000) * MARCH_PX_PER_S) % (DASH + GAP)

    // Links: solid line colour when idle/waiting, marching dashes in the status colour when live.
    const g = this.links
    g.clear()
    const quiet = workers.filter((w) => !LIVE.has(w.status))
    if (quiet.length) {
      for (const w of quiet) g.moveTo(hub.x, hub.y).lineTo(w.x, w.y)
      g.stroke({ width: 2, color: this.colors.line })
    }
    for (const w of workers) {
      if (!LIVE.has(w.status)) continue
      dashes(g, hub, w, march)
      g.stroke({ width: 2, color: this.color(w.status) })
    }

    // Spawn ghost: a dashed outline breathing under each booting station.
    const gh = this.ghosts
    gh.clear()
    const booting = workers.filter((w) => w.status === 'booting')
    if (booting.length) {
      const t = (now % BREATHE_MS) / BREATHE_MS
      const alpha = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(t * Math.PI * 2))
      const pad = 6 + 3 * Math.sin(t * Math.PI * 2)
      for (const w of booting) {
        const { box } = w
        const x0 = box.x - pad, y0 = box.y - pad, x1 = box.x + box.w + pad, y1 = box.y + box.h + pad
        const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
        for (let i = 0; i < 4; i++) dashes(gh, corners[i], corners[(i + 1) % 4], march, 6, 5)
      }
      gh.stroke({ width: 1.5, color: this.color('booting'), alpha })
    }

    // Handoff pulses.
    const p = this.pulseG
    p.clear()
    if (this.pulses.length) {
      const c = this.colors['st-think']
      this.pulses = this.pulses.filter((pl) => now - pl.start < PULSE_LEG_MS * (pl.path.length - 1))
      for (const pl of this.pulses) {
        const legs = pl.path.length - 1
        const prog = (now - pl.start) / PULSE_LEG_MS
        const i = Math.min(legs - 1, Math.floor(prog))
        const t = easeInOut(Math.min(1, prog - i))
        const a = pl.path[i], b = pl.path[i + 1]
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t
        p.circle(x, y, 10).fill({ color: c, alpha: 0.18 })
        p.circle(x, y, 4.5).fill({ color: c })
      }
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    document.removeEventListener('visibilitychange', this.onVisibility)
    const app = this.app
    this.app = null
    // If init is still pending, its continuation sees `destroyed` and tears the app down.
    if (app) app.destroy(true, { children: true, texture: true, textureSource: true })
  }
}

/** Dashed segment from a to b, phase-shifted by `offset` along the line (marching). */
function dashes(g: Graphics, a: Point, b: Point, offset: number, dash = DASH, gap = GAP) {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1) return
  const ux = dx / len, uy = dy / len
  const period = dash + gap
  for (let s = (offset % period) - period; s < len; s += period) {
    const s0 = Math.max(0, s), s1 = Math.min(len, s + dash)
    if (s1 <= s0) continue
    g.moveTo(a.x + ux * s0, a.y + uy * s0).lineTo(a.x + ux * s1, a.y + uy * s1)
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
