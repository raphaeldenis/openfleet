import { expect, type Page, test } from '@playwright/test';
import { readE2eAdminToken } from '../../../scripts/e2e/e2eHome';

const api = 'http://127.0.0.1:7332';
const token = readE2eAdminToken();
const corsHeaders = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

async function reachFirstSessionStepWithACreateThatFails(page: Page) {
  await page.addInitScript(([t, a]) => { localStorage.setItem('openfleet.adminToken', t); localStorage.setItem('openfleet.apiUrl', a); }, [token, api]);
  await page.route('**/api/sessions', (route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: corsHeaders });
    if (method === 'POST') return route.fulfill({ status: 400, headers: corsHeaders, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_body' }) });
    return route.fulfill({ status: 200, headers: corsHeaders, contentType: 'application/json', body: '[]' });
  });
  await page.goto('/onboarding');
  await page.getByLabel('Repository path').fill('/tmp');
  await page.getByRole('button', { name: 'Continue' }).click();
}

for (const viewport of [{ width: 1200, height: 800 }, { width: 1440, height: 900 }]) {
  test(`a create error on the first-session step is visible to the user at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await reachFirstSessionStepWithACreateThatFails(page);

    await page.getByRole('button', { name: 'Create session' }).click();

    const createError = page.getByTestId('new-session-form-error');
    await expect(createError).toBeVisible();
    const isSeenByTheUser = await createError.evaluate((error) => {
      const { left, top, width, height } = error.getBoundingClientRect();
      const centreX = left + width / 2;
      const centreY = top + height / 2;
      const isInsideViewport = centreY >= 0 && centreY <= window.innerHeight;
      const elementOnTop = document.elementFromPoint(centreX, centreY);
      return isInsideViewport && elementOnTop !== null && error.contains(elementOnTop);
    });
    expect(isSeenByTheUser).toBe(true);
  });
}

test('the sticky actions bar of the first-session step sits on the bottom edge of the window, with no content peeking under it', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 600 });
  await reachFirstSessionStepWithACreateThatFails(page);

  const barBottomGap = await page.getByRole('button', { name: 'Create session' }).evaluate((button) => {
    let bar: HTMLElement | null = button.parentElement;
    while (bar && getComputedStyle(bar).position !== 'sticky') bar = bar.parentElement;
    return bar ? window.innerHeight - bar.getBoundingClientRect().bottom : Number.NaN;
  });

  expect(barBottomGap).toBeCloseTo(0, 0);
});
