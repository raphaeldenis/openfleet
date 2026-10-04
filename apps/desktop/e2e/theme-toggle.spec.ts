import { expect, test } from '@playwright/test';
import { readE2eAdminToken } from '../../../scripts/e2e/e2eHome';

const api = 'http://127.0.0.1:7332';
const token = readE2eAdminToken();

const DARK_PANEL = 'rgb(34, 34, 32)';
const LIGHT_PANEL = 'rgb(245, 244, 241)';

test('the top-bar toggle switches the chrome between the light and dark panel tokens', async ({ page }) => {
  await page.addInitScript(([t, a]) => {
    localStorage.setItem('openfleet.adminToken', t);
    localStorage.setItem('openfleet.apiUrl', a);
    localStorage.setItem('openfleet.theme', 'light');
  }, [token, api]);
  await page.goto('/');
  const topBar = page.getByTestId('app-topbar');
  await expect(topBar).toHaveCSS('background-color', LIGHT_PANEL);

  await page.getByRole('button', { name: '☀ Light' }).click();

  await expect(topBar).toHaveCSS('background-color', DARK_PANEL);
});

test('the toggle names the current theme and is pressed exactly while the theme is dark', async ({ page }) => {
  await page.addInitScript(([t, a]) => {
    localStorage.setItem('openfleet.adminToken', t);
    localStorage.setItem('openfleet.apiUrl', a);
    localStorage.setItem('openfleet.theme', 'light');
  }, [token, api]);
  await page.goto('/');
  const lightToggle = page.getByRole('button', { name: '☀ Light' });
  await expect(lightToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(lightToggle).toHaveAttribute('title', 'Switch to dark theme');

  await lightToggle.click();

  const darkToggle = page.getByRole('button', { name: '☾ Dark' });
  await expect(darkToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(darkToggle).toHaveAttribute('title', 'Switch to light theme');

  await darkToggle.click();

  await expect(page.getByRole('button', { name: '☀ Light' })).toHaveAttribute('aria-pressed', 'false');
});
