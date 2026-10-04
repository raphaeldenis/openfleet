import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAsAdmin } from './support/daemon';

const SECTIONS = ['General', 'Models', 'Daemon', 'Diagnostics', 'About'];

interface UnavailableRow { testId: string; value: string; reason: string }

const DISABLED_ROWS: Record<string, UnavailableRow[]> = {
  General: [
    { testId: 'general-docs-root', value: '—', reason: 'Not configurable in this build yet' },
    { testId: 'general-handoff-on-close', value: 'Set in config.json', reason: 'Set handoff.writeOnClose in config.json' },
    { testId: 'general-reply-language', value: '—', reason: 'Not available yet — no language setting in the daemon' },
  ],
  Diagnostics: [
    { testId: 'diagnostics-last-crash', value: '—', reason: 'Not available yet — crash logs are not collected' },
  ],
};

async function openSettings(page: Page): Promise<void> {
  await signInAsAdmin(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
}

const sectionList = (page: Page): Locator => page.getByRole('tablist', { name: 'Settings sections' });
const sectionTab = (page: Page, name: string): Locator => sectionList(page).getByRole('tab', { name, exact: true });

test('Settings has five sections and the gear shows it is pressed while Settings is open', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/');
  const gear = page.getByRole('button', { name: 'Settings' });
  await expect(gear).toHaveAttribute('aria-pressed', 'false');

  await gear.click();

  await expect(gear).toHaveAttribute('aria-pressed', 'true');
  await expect(sectionList(page).getByRole('tab')).toHaveText(SECTIONS);
  await expect(sectionTab(page, 'General')).toHaveAttribute('aria-selected', 'true');
  for (const section of SECTIONS) {
    await sectionTab(page, section).click();
    await expect(sectionTab(page, section)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel').getByRole('heading', { level: 1, name: section })).toBeVisible();
  }
});

for (const [section, rows] of Object.entries(DISABLED_ROWS)) {
  test(`${section} draws the settings without a backing setting as disabled rows that say why`, async ({ page }) => {
    await openSettings(page);
    await sectionTab(page, section).click();

    for (const row of rows) {
      const value = page.getByTestId(row.testId);
      await expect(value).toBeDisabled();
      await expect(value).toHaveAttribute('aria-disabled', 'true');
      await expect(value).toHaveText(row.value);
      await expect(value).toHaveAttribute('title', row.reason);
      await expect(value).toHaveAccessibleDescription(row.reason);
      await expect(page.getByRole('tabpanel').getByText(row.reason, { exact: true })).toBeVisible();
    }
  });
}

test('the Daemon section shows the log and the hand-edited config file as read-only text', async ({ page }) => {
  await openSettings(page);

  await sectionTab(page, 'Daemon').click();

  await expect(page.getByTestId('daemon-log-path')).toHaveText('~/.openfleet/logs/desktop.log');
  await expect(page.getByTestId('daemon-config-path')).toHaveText('~/.openfleet/config.json');
  await expect(page.getByText('Edited by hand for now · restart the daemon after changes')).toBeVisible();
  await expect(page.getByTestId('admin-token-status')).toHaveText('found');
});

test('the Diagnostics export is unavailable outside the desktop app and says so', async ({ page }) => {
  await openSettings(page);

  await sectionTab(page, 'Diagnostics').click();

  const exportButton = page.getByTestId('diagnostics-export');
  await expect(exportButton).toBeDisabled();
  await expect(exportButton).toHaveAttribute('title', 'Available in the OpenFleet desktop app');
  await expect(page.getByTestId('diagnostics-copy-references')).toBeEnabled();
});

test('the About section resolves both versions and keeps Reveal logs off outside the desktop app', async ({ page }) => {
  await openSettings(page);

  await sectionTab(page, 'About').click();

  await expect(page.getByTestId('about-app-version')).not.toHaveText('…');
  await expect(page.getByTestId('about-daemon-version')).not.toHaveText('…');
  await expect(page.getByTestId('about-reveal-logs')).toBeDisabled();
});

test('the Theme row of General switches the theme and the top-bar toggle follows', async ({ page }) => {
  await signInAsAdmin(page, { theme: 'light' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const themeRow = page.getByTestId('general-theme');
  await expect(themeRow).toHaveText('Light');

  await themeRow.click();

  await expect(themeRow).toHaveText('Dark');
  await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-pressed', 'true');
});
