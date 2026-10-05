import { expect, test } from '@playwright/test';
import { readE2eAdminToken } from '../../../scripts/e2e/e2eHome';
import { api } from './support/daemon';

const token = readE2eAdminToken();

const DARK_SIDEBAR = 'rgb(29, 29, 28)';
const LIGHT_SIDEBAR = 'rgb(227, 226, 221)';

test('the sidebar footer toggle switches the chrome between the light and dark panel tokens', async ({ page }) => {
  await page.addInitScript(([t, a]) => {
    localStorage.setItem('openfleet.adminToken', t);
    localStorage.setItem('openfleet.apiUrl', a);
    localStorage.setItem('openfleet.theme', 'light');
  }, [token, api]);
  await page.goto('/');
  const sidebar = page.getByTestId('app-nav');
  const toggle = page.getByTestId('sidebar-footer').getByTestId('theme-toggle');
  await expect(toggle).toHaveText('☀');
  await expect(toggle).not.toContainText('Light');
  await expect(sidebar).toHaveCSS('background-color', LIGHT_SIDEBAR);

  await toggle.click();

  await expect(toggle).toHaveText('☾');
  await expect(sidebar).toHaveCSS('background-color', DARK_SIDEBAR);
});

test('the icon-only toggle names the current theme and is pressed exactly while the theme is dark', async ({ page }) => {
  await page.addInitScript(([t, a]) => {
    localStorage.setItem('openfleet.adminToken', t);
    localStorage.setItem('openfleet.apiUrl', a);
    localStorage.setItem('openfleet.theme', 'light');
  }, [token, api]);
  await page.goto('/');
  const lightToggle = page.getByRole('button', { name: 'Light theme' });
  await expect(lightToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(lightToggle).toHaveAttribute('title', 'Switch to dark theme');

  await lightToggle.click();

  const darkToggle = page.getByRole('button', { name: 'Dark theme' });
  await expect(darkToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(darkToggle).toHaveAttribute('title', 'Switch to light theme');

  await darkToggle.click();

  await expect(page.getByRole('button', { name: 'Light theme' })).toHaveAttribute('aria-pressed', 'false');
});

test('the shell shows no top bar, no status bar, no search trigger and no connection chip while the daemon answers', async ({ page }) => {
  await page.addInitScript(([t, a]) => {
    localStorage.setItem('openfleet.adminToken', t);
    localStorage.setItem('openfleet.apiUrl', a);
  }, [token, api]);

  await page.goto('/');

  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('app-topbar')).toHaveCount(0);
  await expect(page.getByTestId('app-statusbar')).toHaveCount(0);
  await expect(page.getByTestId('open-palette')).toHaveCount(0);
  await expect(page.getByTestId('daemon-status')).toHaveCount(0);
});

test('⌘K opens no command palette', async ({ page }) => {
  await page.addInitScript(([t, a]) => {
    localStorage.setItem('openfleet.adminToken', t);
    localStorage.setItem('openfleet.apiUrl', a);
  }, [token, api]);
  await page.goto('/');

  await page.keyboard.press('Meta+k');

  await expect(page.getByRole('dialog')).toHaveCount(0);
});
