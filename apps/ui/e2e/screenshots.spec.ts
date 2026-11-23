// Regenerates the screenshots referenced in apps/ui/SCREENS.md. Skipped unless COLONY_SCREENSHOTS=1
// (run it with `npm run screenshots` from the repo root, or the manual `screenshots` CI job).
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const enabled = process.env.COLONY_SCREENSHOTS === '1'
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots')

// `ready` is the element that means the screen has loaded; the default is any heading.
type Shot = { file: string; url: string; width: number; height: number; fullPage: boolean; ready?: string }

const at1440 = { width: 1440, height: 900 }
const at1920 = { width: 1920, height: 1080 }

const shots: Shot[] = [
  { file: '01-world', url: '/', ...at1440, fullPage: true },
  { file: '22-world-1920', url: '/', ...at1920, fullPage: true },
  { file: '02-base-readable', url: '/base/1', ...at1440, fullPage: true },
  { file: '21-base-1920', url: '/base/1', ...at1920, fullPage: true },
  { file: '03-roster', url: '/roster', ...at1440, fullPage: true },
  { file: '08-spawn', url: '/spawn', ...at1440, fullPage: true },
  { file: '10-inbox', url: '/inbox', ...at1440, fullPage: true },
  { file: '11-found-new-base', url: '/new', ...at1440, fullPage: true, ready: 'input[placeholder="Name your base"]' },
  { file: '12-settings-limits', url: '/settings/limits', ...at1440, fullPage: true },
  { file: '13-settings-alerts', url: '/settings/alerts', ...at1440, fullPage: true },
  { file: '14-settings-role-library', url: '/settings/roles', ...at1440, fullPage: true },
  { file: '15-merge-review', url: '/review/48', ...at1440, fullPage: true },
  { file: '17-quest-detail', url: '/quest/q-api', ...at1440, fullPage: true },
  { file: '23-ambient-wall-mode', url: '/ambient', ...at1920, fullPage: false, ready: 'text=Press W to leave' },
]

// Wait until the page has loaded its data and the heading is on screen, then let fonts and the
// pixi map canvas finish drawing. Mock mode is frozen (`static`), so nothing moves after this.
async function settle(page: Page, ready: string) {
  await page.waitForLoadState('networkidle')
  await expect(page.locator(ready).first()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(800)
}

;(enabled ? test.describe : test.describe.skip)('UI screenshots', () => {
  test.use({ colorScheme: 'dark', deviceScaleFactor: 1 })
  test.setTimeout(90_000)

  test.beforeAll(() => { mkdirSync(outDir, { recursive: true }) })

  for (const shot of shots) {
    test(shot.file, async ({ page }) => {
      await page.setViewportSize({ width: shot.width, height: shot.height })
      const sep = shot.url.includes('?') ? '&' : '?'
      await page.goto(`${shot.url}${sep}mock&static`)
      await settle(page, shot.ready ?? 'h1, h2')
      await page.screenshot({ path: join(outDir, `${shot.file}.png`), fullPage: shot.fullPage })
    })
  }
})
