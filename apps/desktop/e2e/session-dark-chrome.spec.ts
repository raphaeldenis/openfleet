import { expect, test } from '@playwright/test';
import { readE2eAdminToken } from '../../../scripts/e2e/e2eHome';
import { api } from './support/daemon';

const token = readE2eAdminToken();
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

const DARK_PANEL = 'rgb(34, 34, 32)';

let createdSessionId: string | undefined;

test.afterEach(async ({ request }) => {
  if (!createdSessionId) return;
  await request.post(`${api}/api/sessions/${createdSessionId}/close`, { headers });
  createdSessionId = undefined;
});

for (const viewport of [{ width: 1200, height: 800 }, { width: 1440, height: 900 }]) {
  test(`the session details sit on the dark panel token under the dark theme at ${viewport.width}×${viewport.height}`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(([t, a]) => {
      localStorage.setItem('openfleet.adminToken', t);
      localStorage.setItem('openfleet.apiUrl', a);
      localStorage.setItem('openfleet.rightPanel.open', 'true');
    }, [token, api]);
    const created = await request.post(`${api}/api/sessions`, { headers, data: { directory: '/tmp', name: 'Dark chrome', emoji: '🌙', harness: 'fake' } });
    createdSessionId = (await created.json()).id;

    await page.goto(`/session/${createdSessionId}`);

    await expect(page.getByTestId('session-details')).toBeVisible();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await expect(page.getByTestId('session-details')).toHaveCSS('background-color', DARK_PANEL);
  });
}
