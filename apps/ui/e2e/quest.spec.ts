import { expect, test } from '@playwright/test'

test('a quest in review offers Review merge', async ({ page }) => {
  await page.goto('/quest/q-ui?mock&static')
  await expect(page.getByRole('link', { name: 'Review merge →' })).toBeVisible()
})

test('a quest brief shows the Goal box and file chips', async ({ page }) => {
  await page.goto('/quest/q-api?mock&static')
  await expect(page.getByText('Goal', { exact: true })).toBeVisible()
  await expect(page.getByText('Owns', { exact: true })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: /\.(ts|tsx|sql)$/ }).first()).toBeVisible()
})
