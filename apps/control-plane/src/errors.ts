export class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message)
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details)
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`)
export const conflict = (msg: string, details?: unknown) => new HttpError(409, 'conflict', msg, details)
export const upstream = (msg: string) => new HttpError(502, 'infra_error', msg)

/** Map an InfraDriver failure: validation problems are the caller's fault (400), the rest 502. */
export function infraError(e: unknown, prefix: string): HttpError {
  const err = e as Error
  if (err?.name === 'InfraValidationError') return badRequest(err.message)
  return upstream(`${prefix}: ${err?.message ?? String(e)}`)
}
