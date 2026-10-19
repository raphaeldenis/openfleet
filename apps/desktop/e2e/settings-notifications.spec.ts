import { expect, test, type Page } from '@playwright/test';
import { readE2eAdminToken } from '../../../scripts/e2e/e2eHome';
import { api } from './support/daemon';

const token = readE2eAdminToken();

async function openGeneralSettings(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript(([t, a, th]) => {
    localStorage.setItem('openfleet.adminToken', t);
    localStorage.setItem('openfleet.apiUrl', a);
    localStorage.setItem('openfleet.theme', th);
  }, [token, api, theme]);
  await page.goto('/settings');
  await expect(page.getByRole('switch', { name: 'Notifications' })).toBeVisible();
}

test('notifications are on by default, tool completion and chat message are shown unavailable', async ({ page }) => {
  await openGeneralSettings(page, 'light');

  await expect(page.getByRole('switch', { name: 'Notifications' })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Mute' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Dock badge' })).toBeChecked();
  await expect(page.getByTestId('general-notify-tool-completion')).toBeDisabled();
  await expect(page.getByTestId('general-notify-chat-message')).toBeDisabled();
});

test('a switched-off category stays off after the app is reloaded', async ({ page }) => {
  await openGeneralSettings(page, 'light');

  await page.getByRole('switch', { name: 'Agent finished' }).click();
  await page.reload();

  await expect(page.getByRole('switch', { name: 'Agent finished' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Needs input' })).toBeChecked();
});

for (const theme of ['light', 'dark'] as const) {
  test(`Settings → General in the ${theme} theme`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1200 });
    await openGeneralSettings(page, theme);

    await page.screenshot({ path: testInfo.outputPath(`settings-general-${theme}.png`), fullPage: true });
  });
}
