import { expect, test, type Page } from '@playwright/test';
import { fulfillWithJson, interceptDaemonGet, signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();

const LEGACY_MISSION_BYTES = 30_000;
const MISSION_COUNTER = (page: Page) => page.getByTestId('manager-mission-size');
const MISSION_ERROR = (page: Page) => page.getByTestId('manager-mission-error');
const LEGACY_BANNER = (page: Page) => page.getByTestId('manager-mission-legacy');

const fillMission = async (page: Page, mission: string) => {
  await page.getByTestId('manager-mission').fill(mission);
};

const openNewManagerForm = async (page: Page) => {
  await page.goto('/new?mode=manager');
  await expect(page.getByTestId('manager-mission')).toBeVisible();
};

test('the new manager form counts the mission in KB and blocks a mission above 8 KB without sending anything', async ({ page }) => {
  await signInAsAdmin(page);
  const createRequests: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/api/sessions')) createRequests.push(request.url()); });
  await openNewManagerForm(page);

  await fillMission(page, 'a'.repeat(7373));
  await expect(MISSION_COUNTER(page)).toHaveText('7.2 / 8 KB');
  await expect(MISSION_ERROR(page)).toHaveCount(0);

  await fillMission(page, 'a'.repeat(8193));
  await expect(MISSION_ERROR(page)).toContainText('Mission must be at most 8 KB');
  await page.getByRole('textbox', { name: 'Name' }).fill('Lead');
  await page.locator('form').first().evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(MISSION_ERROR(page)).toBeVisible();
  expect(createRequests).toEqual([]);
});

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1200, height: 800 }] as const;
const THEMES = ['light', 'dark'] as const;

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    const shotName = (state: string) => `../../mt4-mission-${state}-${theme}-${viewport.width}x${viewport.height}.png`;

    test(`design QA: the mission size under the limit, above it and legacy, in the ${theme} theme at ${viewport.width}x${viewport.height}`, async ({ page, request }) => {
      await page.setViewportSize(viewport);
      await signInAsAdmin(page, { theme });
      await openNewManagerForm(page);

      await fillMission(page, 'a'.repeat(7373));
      await expect(MISSION_COUNTER(page)).toHaveText('7.2 / 8 KB');
      await page.screenshot({ path: shotName('under'), fullPage: true });

      await fillMission(page, 'a'.repeat(8193));
      await expect(MISSION_ERROR(page)).toBeVisible();
      await page.screenshot({ path: shotName('over'), fullPage: true });

      const manager = await fakeSessions.create(request, { name: 'Lead', manager: { pulseSeconds: 3600, childrenCap: 2, mission: 'Ship the delta' } });
      await interceptDaemonGet(page, `/api/managers/${manager.id}`, async (route) => {
        const real = await (await route.fetch()).json();
        await fulfillWithJson(route, 200, { ...real, manager: { ...real.manager, missionText: 'l'.repeat(LEGACY_MISSION_BYTES), legacyMission: true } });
      });
      await page.goto(`/manager/${manager.id}`);
      await expect(LEGACY_BANNER(page)).toHaveText(/Legacy mission: reduce it to the delta/);
      await expect(MISSION_COUNTER(page)).toHaveText('29.3 / 8 KB');
      await page.getByTestId('manager-mission').scrollIntoViewIfNeeded();
      await page.screenshot({ path: shotName('legacy'), fullPage: true });
    });
  }
}
