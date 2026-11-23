import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => { await page.goto('/roster?mock&static') })

test('clicking a card opens the Inspector; the checkbox only selects', async ({ page }) => {
  const inspector = page.getByRole('complementary', { name: /^Inspector/ })
  await page.getByRole('checkbox', { name: 'Select vex-07' }).check()
  await expect(page.getByText('1 selected')).toBeVisible()
  await expect(inspector).toHaveCount(0)

  await page.getByRole('button', { name: 'Inspect rho-09' }).click()
  await expect(inspector).toBeVisible()
  await expect(inspector).toContainText('rho-09')
})

test('all cards have equal height', async ({ page }) => {
  const cards = page.getByRole('button', { name: /^Inspect / })
  await expect(cards.first()).toBeVisible()
  const heights = await cards.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
  expect(heights.length).toBeGreaterThan(3)
  expect(new Set(heights).size).toBe(1)
})
