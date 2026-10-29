import { expect, test } from '@playwright/test';
import { readE2eAdminToken } from '../../../scripts/e2e/e2eHome';
import { api } from './support/daemon';

const token = readE2eAdminToken();
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

let createdSessionId: string | undefined;

test.afterEach(async ({ request }) => {
  if (!createdSessionId) return;
  await request.post(`${api}/api/sessions/${createdSessionId}/close`, { headers });
  createdSessionId = undefined;
});

for (const theme of ['light', 'dark']) {
  test(`Escape closes only the close dialog, keeps the right panel open and returns focus to Close under the ${theme} theme`, async ({ page, request }) => {
    await page.addInitScript(([adminToken, apiUrl, chosenTheme]) => {
      localStorage.setItem('openfleet.adminToken', adminToken!);
      localStorage.setItem('openfleet.apiUrl', apiUrl!);
      localStorage.setItem('openfleet.rightPanel.open', 'true');
      localStorage.setItem('openfleet.theme', chosenTheme!);
    }, [token, api, theme]);
    const created = await request.post(`${api}/api/sessions`, { headers, data: { directory: '/tmp', name: 'Escape dialog', emoji: '⎋', harness: 'fake' } });
    createdSessionId = (await created.json()).id;
    await page.goto(`/session/${createdSessionId}`);
    const rightPanel = page.getByTestId('right-panel');
    const closeButton = rightPanel.getByTestId('session-close');
    await expect(closeButton).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    await closeButton.click();
    await expect(page.getByTestId('close-confirm-dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('close-confirm-dialog')).toHaveCount(0);
    await expect(rightPanel).toBeVisible();
    await expect(closeButton).toBeFocused();
  });
}
