import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => { await page.goto('/inbox?mock&static') })

const card = (page: Page, text: string) => page.locator('article', { hasText: text })

test('a heads-up dismisses in one click and Undo brings it back', async ({ page }) => {
  const pace = card(page, 'Session 62%')
  await pace.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(pace).toHaveCount(0)
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
  await expect(pace).toBeVisible()
})

test('a critical card needs a second click, then Dismissed lists it and Reopen restores it', async ({ page }) => {
  const crash = card(page, 'ran out of memory (exit 137)')
  const dismiss = crash.getByRole('button', { name: 'Dismiss' })
  await dismiss.click()
  await expect(crash).toBeVisible()
  await expect(dismiss).toHaveText('Dismiss? Click again')
  await dismiss.click()
  await expect(crash).toHaveCount(0)

  await page.getByRole('button', { name: /dismissed or resolved/ }).click()
  const row = page.locator('div').filter({ has: page.getByRole('button', { name: 'Reopen' }), hasText: 'ran out of memory (exit 137)' }).last()
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Reopen' }).click()
  await expect(crash).toBeVisible()
})
