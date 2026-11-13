// A generated emblem per agent (docs/feedback.md #3): shape + backdrop pattern + glyph + hue,
// all picked from a hash of the agent's iconSeed (or its id), so the same agent looks the same
// on the roster, the base map, the Inspector, the feed and the Spawn preview. Inline SVG only.
import { useId, type ReactNode } from 'react'
import type { Agent, RoleId } from '@/types/colony'
import { ROLES } from '@/design/status'
import { cx } from '@/lib/util'

/** The seed an agent's emblem is drawn from. Mock agents have no iconSeed, so their id is used. */
export const agentSeed = (a: Pick<Agent, 'id' | 'iconSeed'>) => a.iconSeed || a.id

/** A fresh seed for "reroll" (fits the control plane's 1–32 chars of [A-Za-z0-9-]). */
export const randomIconSeed = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0')

/** FNV-1a, then a little avalanche so neighbouring seeds ("vex-07", "vex-08") differ a lot. */
function hash(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15
  return h >>> 0
}

// Hues spaced around the wheel. Rendered dark-on-dark (deep fill, light stroke and glyph), so
// they read on the theme's surfaces without competing with the bright status tokens.
const HUES = [8, 28, 46, 70, 100, 145, 168, 188, 205, 225, 248, 270, 292, 318, 340]

function seal(points: number, outer: number, inner: number) {
  const pts: string[] = []
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer
    const a = (Math.PI * i) / points - Math.PI / 2
    pts.push(`${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`)
  }
  return `M${pts.join('L')}Z`
}

/** Outer shapes in a 100×100 box, with how much the glyph shrinks to stay inside. */
const SHAPES: { d: string; k: number }[] = [
  { d: 'M50 4L90 27V73L50 96L10 73V27Z', k: 1 },                              // hexagon
  { d: 'M50 4L89 17V47C89 71 72 88 50 96C28 88 11 71 11 47V17Z', k: 0.95 },  // shield
  { d: 'M50 3L97 50L50 97L3 50Z', k: 0.8 },                                   // diamond
  { d: 'M50 5A45 45 0 1 1 49.9 5Z', k: 1 },                                   // circle
  { d: 'M10 7H90V62L50 95L10 62Z', k: 0.9 },                                  // pennant (chevron)
  { d: 'M31 5H69L95 31V69L69 95H31L5 69V31Z', k: 1 },                         // octagon
  { d: seal(12, 47, 40), k: 0.95 },                                           // seal (star)
  { d: 'M28 5H72C86 5 95 14 95 28V72C95 86 86 95 72 95H28C14 95 5 86 5 72V28C5 14 14 5 28 5Z', k: 1 }, // squircle
]

/** Backdrop patterns, clipped to the shape. */
const PATTERNS: ((c: string) => ReactNode)[] = [
  () => null,                                                                             // flat
  (c) => <rect x="0" y="0" width="50" height="100" fill={c} />,                         // split
  (c) => <rect x="0" y="36" width="100" height="28" fill={c} />,                        // band
  (c) => <path d="M-10 30L30 -10M-10 60L60 -10M-10 90L90 -10M10 110L110 10M40 110L110 40M70 110L110 70" stroke={c} strokeWidth="7" />, // stripes
  (c) => <path d="M0 100L100 0V100Z" fill={c} />,                                       // diagonal
]

/** Glyphs centred on (50,50), roughly within r=22. */
const GLYPHS: ((c: string) => ReactNode)[] = [
  (c) => <circle cx="50" cy="50" r="14" fill="none" stroke={c} strokeWidth="7" />,                                    // ring
  (c) => <><circle cx="50" cy="50" r="20" fill="none" stroke={c} strokeWidth="4" /><circle cx="50" cy="50" r="8" fill={c} /></>, // target
  (c) => <path d="M36 32V68M50 26V74M64 32V68" stroke={c} strokeWidth="7" strokeLinecap="round" />,                   // bars
  (c) => <path d="M50 28V72M28 50H72" stroke={c} strokeWidth="9" strokeLinecap="round" />,                            // plus
  (c) => <path d="M50 28L72 68H28Z" fill={c} />,                                                                     // triangle
  (c) => <path d="M30 52L50 34L70 52M30 70L50 52L70 70" fill="none" stroke={c} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />, // chevrons
  (c) => <><circle cx="50" cy="33" r="8" fill={c} /><circle cx="34" cy="62" r="8" fill={c} /><circle cx="66" cy="62" r="8" fill={c} /></>, // trio
  (c) => <path d="M50 26L72 50L50 74L28 50Z" fill="none" stroke={c} strokeWidth="7" strokeLinejoin="round" />,         // rhombus
  (c) => <path d="M56 24L36 54H50L44 76L66 44H52Z" fill={c} />,                                                     // bolt
  (c) => <><path d="M26 50C34 36 66 36 74 50C66 64 34 64 26 50Z" fill="none" stroke={c} strokeWidth="5" /><circle cx="50" cy="50" r="7" fill={c} /></>, // eye
]

export interface Emblem { shape: number; pattern: number; glyph: number; hue: number }

export function emblemFor(seed: string): Emblem {
  const h = hash(seed)
  return {
    shape: h % SHAPES.length,
    glyph: Math.floor(h / SHAPES.length) % GLYPHS.length,
    pattern: Math.floor(h / (SHAPES.length * GLYPHS.length)) % PATTERNS.length,
    hue: HUES[Math.floor(h / (SHAPES.length * GLYPHS.length * PATTERNS.length)) % HUES.length],
  }
}

/** Just the SVG emblem. */
export function Emblem({ seed, size, title }: { seed: string; size: number; title?: string }) {
  const clip = useId()
  const e = emblemFor(seed)
  const shape = SHAPES[e.shape]
  const fill = `hsl(${e.hue} 38% 20%)`
  const tint = `hsl(${e.hue} 42% 27%)`
  const stroke = `hsl(${e.hue} 62% 60%)`
  const glyph = `hsl(${e.hue} 80% 80%)`
  // Thin lines vanish at small sizes; thicken the outline as the emblem shrinks.
  const sw = size <= 30 ? 7 : size <= 48 ? 5 : 3.5
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} className="block shrink-0 overflow-visible">
      {title && <title>{title}</title>}
      <defs><clipPath id={clip}><path d={shape.d} /></clipPath></defs>
      <path d={shape.d} fill={fill} />
      <g clipPath={`url(#${clip})`}>{PATTERNS[e.pattern](tint)}</g>
      <g transform={`translate(50 50) scale(${shape.k}) translate(-50 -50)`}>{GLYPHS[e.glyph](glyph)}</g>
      <path d={shape.d} fill="none" stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
    </svg>
  )
}

/**
 * An agent's emblem, with an optional role badge (bottom-left: BE, FE, QA…) and level chip
 * (bottom-right), so the class stays readable now that the icon no longer spells it out.
 */
export function AgentIcon({ agent, seed, role, size = 46, level, showRole = true, className }: {
  agent?: Pick<Agent, 'id' | 'iconSeed' | 'role' | 'callsign'>
  seed?: string
  role?: RoleId
  size?: number
  level?: number
  showRole?: boolean
  className?: string
}) {
  const s = seed ?? (agent ? agentSeed(agent) : 'colony')
  const r = role ?? agent?.role
  const badge = Math.max(8, Math.round(size * 0.22))
  return (
    <span className={cx('relative inline-block shrink-0', className)} style={{ width: size, height: size }}
      title={agent ? `${agent.callsign}${r ? ` · ${ROLES[r].name}` : ''}` : undefined}>
      <Emblem seed={s} size={size} />
      {showRole && r && (
        <span className="absolute -bottom-1 -left-1.5 rounded-xs border border-line-strong bg-ground px-[3px] font-mono font-semibold leading-[1.25] text-ink-soft"
          style={{ fontSize: badge }}>{ROLES[r].code}</span>
      )}
      {level != null && (
        <span className="absolute -bottom-1.5 -right-1.5 rounded-sm border border-line-strong bg-ground px-1 font-display leading-[1.3]"
          style={{ fontSize: Math.max(10, Math.round(size * 0.22)) }}>{level}</span>
      )}
    </span>
  )
}
