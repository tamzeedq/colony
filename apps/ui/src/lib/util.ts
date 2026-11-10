export const cx = (...c: (string | false | null | undefined | 0)[]) => c.filter(Boolean).join(' ')

export const usd = (n: number) => `$${n.toFixed(2)}`
export const pct = (n: number) => `${Math.round(n)}%`

export function ago(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function untilLabel(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  const h = Math.floor(m / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h ? `${h}h ${m % 60}m` : `${m}m`
}

export function clock(iso: string) {
  const d = new Date(iso)
  return d.toTimeString().slice(0, 8)
}

export const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}
