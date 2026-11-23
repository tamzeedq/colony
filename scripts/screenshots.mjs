// Regenerates the UI screenshots in apps/ui/screenshots (see apps/ui/SCREENS.md).
// Sets COLONY_SCREENSHOTS=1 for the Playwright run; without it the spec is skipped.
// usage: npm run screenshots
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'ui')

const child = spawn('npx playwright test e2e/screenshots.spec.ts', {
  cwd: uiDir,
  env: { ...process.env, COLONY_SCREENSHOTS: '1' },
  stdio: 'inherit',
  shell: true, // npx is npx.cmd on Windows; Node refuses to spawn .cmd files without a shell
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
