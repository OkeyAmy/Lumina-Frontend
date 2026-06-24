import { expect, test } from '@playwright/test'

test.describe('Activity log virtualization', () => {
  test('keeps rendered rows capped while scrolling a large log', async ({ page }) => {
    await page.goto('/dashboard/facility')

    const scrollport = page.getByTestId('activity-log-scrollport')
    await expect(scrollport).toBeVisible()

    for (const position of [0, 8_000, 80_000, 160_000, 240_000]) {
      await scrollport.evaluate((element, top) => {
        element.scrollTop = top
        element.dispatchEvent(new Event('scroll'))
      }, position)
      await page.waitForTimeout(50)
      const renderedRows = await page.getByTestId('activity-log-row').count()
      expect(renderedRows).toBeLessThanOrEqual(100)
    }
  })
})
