// @colony/agent-runner entry point. Runs as the container's main process (under tini):
//   node /opt/colony/runner.mjs
// See README.md and docs/phase1.md "Runner behaviour".

import { ConfigError, loadConfig, type RunnerConfig } from './config'
import { createLogger } from './log'
import { Runner } from './runner'

const log = createLogger('runner')

let config: RunnerConfig
try {
  config = loadConfig(process.env)
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`${e.message}\n`)
    process.exit(2)
  }
  throw e
}

const runner = new Runner(config, { log, exit: (code) => process.exit(code) })

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { void runner.shutdown('signal') })
}
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', err.stack ?? err)
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection', err instanceof Error ? err.stack ?? err : err)
  process.exit(1)
})

runner.start().catch((err) => {
  log.error('runner failed to start', err)
  process.exit(1)
})
