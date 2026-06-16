import { test, expect } from '@playwright/test';

test('architecture tab renders a Mermaid diagram screenshot', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Architecture' }).click();

  const diagram = page.getByTestId('architecture-diagram');
  await expect(diagram).toBeVisible();
  await expect(page.locator('#architecture-meta')).toContainText('demo-repo');
  await expect(page.locator('#architecture-meta')).toContainText('2 components');
  await expect(page.locator('#architecture-output svg')).toBeVisible({ timeout: 10000 });

  await page.screenshot({
    path: 'test-results/architecture-tab.png',
    fullPage: true,
  });
});
