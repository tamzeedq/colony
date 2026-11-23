import { expect, test } from '@playwright/test'

test('Pause all counts down, Cancel aborts', async ({ page }) => {
  await page.goto('/roster?mock&static')
  await page.getByRole('button', { name: /Pause all/ }).click()
  const bar = page.getByRole('status').filter({ hasText: /Pausing in \d/ })
  // The countdown may already be at 2 or 1 by the time this runs; any second counts.
  await expect(bar).toContainText(/Pausing in [1-3]…/)
  await bar.getByRole('button', { name: 'Cancel' }).click()
  await expect(bar).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Pause all/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Resume all/ })).toHaveCount(0)
})

test('letting the countdown run ends with Resume all', async ({ page }) => {
  await page.goto('/roster?mock&static')
  await page.getByRole('button', { name: /Pause all/ }).click()
  await expect(page.getByRole('status').filter({ hasText: /Pausing in \d/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '▸ Resume all' })).toBeVisible({ timeout: 15_000 })
})
