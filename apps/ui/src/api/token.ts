// Admin token pairing (docs/phase2.md "Auth"). The browser holds the token; nothing on the host
// injects it. The control plane prints `http://localhost:5173/#pair=<token>`; we read it once,
// store it, and strip it from the URL.

const KEY = 'colony.adminToken'
type Listener = (token: string | null) => void
const listeners = new Set<Listener>()

function read(): string | null {
  try { return localStorage.getItem(KEY) } catch { return null }
}

let current: string | null = read()

export const getToken = () => current

export function setToken(token: string | null) {
  const t = token?.trim() || null
  current = t
  try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY) } catch { /* storage blocked */ }
  listeners.forEach((fn) => fn(t))
}

export const clearToken = () => setToken(null)

export function onTokenChange(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn) } }

/** Read `#pair=<token>` once, store it, and remove the hash from the address bar. */
export function consumePairHash() {
  const m = /^#pair=(.+)$/.exec(location.hash)
  if (!m) return
  let token = m[1]
  try { token = decodeURIComponent(token) } catch { /* use as-is */ }
  setToken(token)
  history.replaceState(history.state, '', location.pathname + location.search)
}
