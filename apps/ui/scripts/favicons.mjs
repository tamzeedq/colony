// Generates the Ops Deck tab icons in apps/ui/public from one geometry, with no dependencies:
//   favicon.svg        amber hexagon + dot (the HUD logo) on the HUD's dark tile
//   favicon-alert.svg  the same with a coral dot, shown while alerts need you
//   favicon-32.png     PNG fallback
//   apple-touch-icon.png  180 px, full-bleed tile (iOS rounds the corners itself)
// Run: node apps/ui/scripts/favicons.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync, crc32 } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../public/', import.meta.url))
// apps/ui/tokens/theme.css
const HUD = '#0A0D11', AMBER = '#F0B44C', CORAL = '#F2706A'

// 32-unit design space. Hexagon matches the logo's path (pointy top), scaled up and thickened for 16 px.
const C = 16, R = 10.5, STROKE = 2.6, DOT = 3.3
const HEX = Array.from({ length: 6 }, (_, k) => {
  const a = (Math.PI / 180) * (-90 + 60 * k)
  return [C + R * Math.cos(a), C + R * Math.sin(a)]
})
const BADGE = { x: 25.5, y: 6.5, r: 5.2, ring: 1.8 }

function svg({ alert }) {
  const pts = HEX.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="${HUD}"/>
  <path d="M${pts}Z" fill="none" stroke="${AMBER}" stroke-width="${STROKE}" stroke-linejoin="round"/>
  <circle cx="${C}" cy="${C}" r="${DOT}" fill="${AMBER}"/>${alert ? `
  <circle cx="${BADGE.x}" cy="${BADGE.y}" r="${BADGE.r + BADGE.ring}" fill="${HUD}"/>
  <circle cx="${BADGE.x}" cy="${BADGE.y}" r="${BADGE.r}" fill="${CORAL}"/>` : ''}
</svg>
`
}

// ── tiny rasterizer: 4×4 supersampling over the same shapes ──
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
function inRoundRect(x, y, rx) {
  if (x < 0 || y < 0 || x > 32 || y > 32) return false
  const cx = Math.min(Math.max(x, rx), 32 - rx), cy = Math.min(Math.max(y, rx), 32 - rx)
  return Math.hypot(x - cx, y - cy) <= rx
}
function sample(x, y, rx) {
  if (!inRoundRect(x, y, rx)) return null
  let c = HUD
  if (HEX.some((p, i) => segDist(x, y, p, HEX[(i + 1) % 6]) <= STROKE / 2)) c = AMBER
  if (Math.hypot(x - C, y - C) <= DOT) c = AMBER
  return c
}
function png(size, rx) {
  const S = 4, k = 32 / size
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const c = sample((px + (sx + 0.5) / S) * k, (py + (sy + 0.5) / S) * k, rx)
        if (!c) continue
        const [cr, cg, cb] = rgb(c)
        r += cr; g += cg; b += cb; a++
      }
      const o = py * (size * 4 + 1) + 1 + px * 4
      raw[o] = a ? Math.round(r / a) : 0; raw[o + 1] = a ? Math.round(g / a) : 0; raw[o + 2] = a ? Math.round(b / a) : 0
      raw[o + 3] = Math.round((a / (S * S)) * 255)
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

mkdirSync(OUT, { recursive: true })
writeFileSync(OUT + 'favicon.svg', svg({ alert: false }))
writeFileSync(OUT + 'favicon-alert.svg', svg({ alert: true }))
writeFileSync(OUT + 'favicon-32.png', png(32, 7))
writeFileSync(OUT + 'apple-touch-icon.png', png(180, 0))
console.log('wrote favicon.svg, favicon-alert.svg, favicon-32.png, apple-touch-icon.png to', OUT)
