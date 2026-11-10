// Minimal stderr logger. stdout is left alone (Docker captures both; nothing parses ours).
// Never pass secrets (agent token, OAuth token) to these functions.

export type LogFn = (msg: string, extra?: unknown) => void

export interface Logger {
  info: LogFn
  warn: LogFn
  error: LogFn
}

function fmt(level: string, scope: string, msg: string, extra?: unknown): string {
  let tail = ''
  if (extra instanceof Error) tail = ` ${extra.message}`
  else if (extra !== undefined) {
    try { tail = ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` } catch { tail = ` ${String(extra)}` }
  }
  return `${new Date().toISOString()} ${level} [${scope}] ${msg}${tail}\n`
}

export function createLogger(scope: string): Logger {
  const w = (level: string): LogFn => (msg, extra) => { process.stderr.write(fmt(level, scope, msg, extra)) }
  return { info: w('INFO'), warn: w('WARN'), error: w('ERROR') }
}
