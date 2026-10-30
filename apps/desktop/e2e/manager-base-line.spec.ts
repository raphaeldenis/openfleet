import { expect, test } from '@playwright/test';
import { adminHeaders, api, fulfillWithJson, interceptDaemonGet, signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();
const READ_AT = '2026-10-15T12:00:00.000Z';

const openProfile = async (page: import('@playwright/test').Page, managerId: string) => {
  await page.goto(`/manager/${managerId}`);
  await expect(page.getByRole('region', { name: 'Profile' })).toBeVisible();
};
const baseFact = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Profile' }).locator('.fact', { hasText: 'Manager base' });

test('a manager that never read the base shows the current version as not read, with nothing to click', async ({ page, request }) => {
  await signInAsAdmin(page);
  const manager = await fakeSessions.create(request, { name: 'Lead', manager: { pulseSeconds: 3600, childrenCap: 2, mission: 'Ship the base' } });
  const { version } = await (await request.get(`${api}/api/manager-base`, { headers: adminHeaders })).json();

  await openProfile(page, manager.id);

  await expect(baseFact(page)).toContainText(`Base v${version}, not read`);
  await expect(baseFact(page).getByRole('button')).toHaveCount(0);
  await expect(baseFact(page).getByRole('link')).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`design QA: the base line of the manager profile, read and not read, in the ${theme} theme`, async ({ page, request }, testInfo) => {
    await signInAsAdmin(page, { theme });
    const manager = await fakeSessions.create(request, { name: 'Lead', manager: { pulseSeconds: 3600, childrenCap: 2, mission: 'Ship the base' } });
    const { version, sha } = await (await request.get(`${api}/api/manager-base`, { headers: adminHeaders })).json();

    await openProfile(page, manager.id);
    await expect(baseFact(page)).toContainText('not read');
    await page.screenshot({ path: testInfo.outputPath(`mt2-base-line-unread-${theme}.png`),fullPage: true });

    await interceptDaemonGet(page, `/api/managers/${manager.id}`, async (route) => {
      const real = await (await route.fetch()).json();
      await fulfillWithJson(route, 200, { ...real, manager: { ...real.manager, baseRead: { version, sha, readAt: READ_AT } } });
    });
    await openProfile(page, manager.id);
    await expect(baseFact(page)).toContainText(`Base v${version}, read on`);
    await page.screenshot({ path: testInfo.outputPath(`mt2-base-line-read-${theme}.png`),fullPage: true });
  });
}
