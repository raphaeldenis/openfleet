import { expect, type Page, test } from '@playwright/test';
import { readE2eAdminToken } from '../../../scripts/e2e/e2eHome';
import { api, fulfillWithJson, interceptDaemonGet } from './support/daemon';

const token = readE2eAdminToken();

const DARK_BACKGROUND = 'rgb(26, 26, 25)';
const DARK_TEXT = 'rgb(236, 235, 230)';

async function openOnboardingUnderTheRememberedDarkTheme(page: Page) {
  await interceptDaemonGet(page, '/api/sessions', (route) => fulfillWithJson(route, 200, []));
  await page.addInitScript(([adminToken, apiUrl]) => {
    localStorage.setItem('openfleet.adminToken', adminToken!);
    localStorage.setItem('openfleet.apiUrl', apiUrl!);
    localStorage.setItem('openfleet.theme', 'dark');
  }, [token, api]);
  await page.goto('/onboarding');
}

async function expectDarkOnboarding(page: Page) {
  const onboarding = page.getByTestId('onboarding');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(onboarding).toHaveCSS('background-color', DARK_BACKGROUND);
  await expect(onboarding).toHaveCSS('color', DARK_TEXT);
}

test('the project step and the first-session step of the onboarding wear the dark theme', async ({ page }) => {
  await openOnboardingUnderTheRememberedDarkTheme(page);
  await expect(page.getByTestId('onboarding-step-project')).toBeVisible();
  await expectDarkOnboarding(page);

  await page.getByLabel('Repository path').fill('/tmp');
  await page.getByLabel('Name', { exact: true }).fill('Dark onboarding project');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByTestId('onboarding-step-first-session')).toBeVisible();
  await expectDarkOnboarding(page);
});
