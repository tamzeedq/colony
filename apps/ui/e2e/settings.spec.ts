import { expect, test } from '@playwright/test'

test('choosing a team check-in interval selects that button', async ({ page }) => {
  await page.goto('/settings/limits?mock&static')
  const group = page.getByRole('radiogroup', { name: 'Team check-in interval' })
  const ten = group.getByRole('radio', { name: '10 min' })
  await expect(ten).toHaveAttribute('aria-checked', 'false')
  await ten.click()
  await expect(ten).toHaveAttribute('aria-checked', 'true')
  await expect(group.getByRole('radio', { checked: true })).toHaveCount(1)
})
