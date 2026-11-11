// REST client for the control plane. Same-origin `/api/*` (Vite proxies it in dev, as-is).
// Adds `Authorization: Bearer <token>`, turns `{ error: { code, message } }` into ApiError,
// and on 401 clears the stored token so the app falls back to the Pair screen.
import { clearToken, getToken } from './token'

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

async function request(method: Method, path: string, body?: unknown, accept = 'application/json'): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (e) {
    throw new ApiError(0, 'network', `Can't reach the control plane (${(e as Error).message})`)
  }
  if (res.ok) return res
  let code = `http_${res.status}`, message = res.statusText || `HTTP ${res.status}`, details: unknown
  let fromApi = false
  try {
    const j = await res.json() as { error?: { code?: string; message?: string; details?: unknown } }
    if (j?.error) { fromApi = true; code = j.error.code ?? code; message = j.error.message ?? message; details = j.error.details }
  } catch { /* not JSON (e.g. the dev proxy's error page) */ }
  // The Vite proxy answers 5xx without our JSON error shape when nothing listens on :7700.
  if (!fromApi && res.status >= 500) { code = 'unreachable'; message = `Control plane unreachable (${res.status})` }
  if (res.status === 401) clearToken()
  throw new ApiError(res.status, code, message, details)
}

export async function api<T = unknown>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await request(method, path, body)
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export async function apiText(path: string): Promise<string> {
  const res = await request('GET', path, undefined, 'text/plain')
  return res.text()
}

export const enc = encodeURIComponent

export function errorMessage(e: unknown) {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : String(e)
}

/** ws:// or wss:// URL on this origin. */
export function wsUrl(path: string, params: Record<string, string | number>) {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}?${q}`
}
