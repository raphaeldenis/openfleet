import { expect, test } from '@playwright/test';
import { signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();
const VIEWPORT = { width: 1200, height: 900 };

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ viewport: VIEWPORT });

    test(`design QA: pulse, children cap and model share one row and the live dashboard stays above the fold at 1200 (${theme})`, async ({ page, request }, testInfo) => {
      await signInAsAdmin(page, { theme });
      const manager = await fakeSessions.create(request, { name: 'Lead', manager: { pulseSeconds: 3600, childrenCap: 2, mission: 'Ship the base' } });

      await page.goto(`/manager/${manager.id}`);
      const row = page.getByRole('group', { name: 'Pulse, children cap and model' });
      await expect(row).toBeVisible();

      const tops = await Promise.all(
        [row.getByRole('spinbutton', { name: 'Pulse cadence' }), row.getByRole('spinbutton', { name: 'Children cap' }), row.getByRole('combobox', { name: 'Model' })].map(
          async (control) => Math.round((await control.boundingBox())!.y),
        ),
      );
      expect(new Set(tops).size).toBe(1);

      const pulseNow = await page.getByTestId('manager-dashboard-pulse').boundingBox();
      expect(pulseNow!.y + pulseNow!.height).toBeLessThanOrEqual(VIEWPORT.height);
      const childrenCard = await page.getByRole('heading', { name: 'Children' }).or(page.getByText('Children', { exact: true }).first()).first().boundingBox();
      expect(childrenCard!.y).toBeLessThanOrEqual(VIEWPORT.height);
      await page.screenshot({ path: testInfo.outputPath(`manager-profile-layout-${theme}.png`) });
    });

    test(`design QA: an unknown manager says Manager not found and the right panel does not ask to select a session (${theme})`, async ({ page }) => {
      await signInAsAdmin(page, { theme });

      await page.goto('/manager/does-not-exist');

      await expect(page.getByText('Manager not found')).toBeVisible();
      await expect(page.getByText('Select a session to see its details.')).toHaveCount(0);
    });
  });
}
