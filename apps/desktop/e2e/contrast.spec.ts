import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readE2eAdminToken } from '../../../scripts/e2e/e2eHome';
import { api, fulfillWithJson, interceptDaemonGet } from './support/daemon';

const token = readE2eAdminToken();

const MINIMUM_TEXT_CONTRAST = 4.5;
const THEMES = ['light', 'dark'] as const;
const VIEWPORTS = [{ width: 1200, height: 800 }, { width: 1440, height: 900 }];

type Theme = (typeof THEMES)[number];

async function measureContrastRatio(page: Page, testIdOrSelector: string): Promise<number> {
  return page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`no element matches ${selector}`);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const toRgba = (cssColor: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = cssColor;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const luminance = ([r, g, b]: number[]) => {
      const [lr, lg, lb] = [r, g, b].map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };

    let backgroundColor: number[] = [255, 255, 255];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const [r, g, b, a] = toRgba(getComputedStyle(node).backgroundColor);
      if (a === 1) {
        backgroundColor = [r, g, b];
        break;
      }
    }
    const textColor = toRgba(getComputedStyle(element).color).slice(0, 3);
    const [lighter, darker] = [luminance(textColor), luminance(backgroundColor)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  }, testIdOrSelector);
}

const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

let createdSessionId: string | undefined;

test.afterEach(async ({ request }) => {
  if (!createdSessionId) return;
  await request.post(`${api}/api/sessions/${createdSessionId}/close`, { headers });
  createdSessionId = undefined;
});

async function openSessionUnderTheme(page: Page, request: APIRequestContext, theme: Theme, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.addInitScript(([adminToken, apiUrl, chosenTheme]) => {
    localStorage.setItem('openfleet.adminToken', adminToken);
    localStorage.setItem('openfleet.apiUrl', apiUrl);
    localStorage.setItem('openfleet.rightPanel.open', 'true');
    document.documentElement.setAttribute('data-theme', chosenTheme);
  }, [token, api, theme satisfies Theme]);
  const created = await request.post(`${api}/api/sessions`, { headers, data: { directory: '/tmp', name: 'Danger contrast', emoji: '🛑', harness: 'fake' } });
  createdSessionId = (await created.json()).id;
  await page.goto(`/session/${createdSessionId}`);
  await page.evaluate((chosenTheme) => document.documentElement.setAttribute('data-theme', chosenTheme), theme);
  await expect(page.getByTestId('session-details')).toBeVisible();
}

async function resolveTokenFillColor(page: Page, tokenName: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = `var(${name})`;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, tokenName);
}

async function expectDangerButtonReadable(page: Page, testId: string) {
  const dangerButton = page.getByTestId(testId);
  await expect(dangerButton).toBeVisible();
  const expectedFill = await resolveTokenFillColor(page, '--state-error-fill');
  const expectedLabel = await resolveTokenFillColor(page, '--on-state');

  await expect(dangerButton).toHaveCSS('background-color', expectedFill);
  await expect(dangerButton).toHaveCSS('color', expectedLabel);
  expect(await measureContrastRatio(page, `[data-testid="${testId}"]`)).toBeGreaterThanOrEqual(MINIMUM_TEXT_CONTRAST);
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`the Close session danger button reaches 4.5:1 on the error fill under the ${theme} theme at ${viewport.width}×${viewport.height}`, async ({ page, request }) => {
      await openSessionUnderTheme(page, request, theme, viewport);

      await page.getByTestId('session-close').click();

      await expectDangerButtonReadable(page, 'close-confirm-submit');
    });

    test(`the Turn off checks danger button reaches 4.5:1 on the error fill under the ${theme} theme at ${viewport.width}×${viewport.height}`, async ({ page, request }) => {
      await openSessionUnderTheme(page, request, theme, viewport);

      await page.getByTestId('permission-mode-trigger').click();
      await page.getByRole('option', { name: /bypassPermissions/ }).click();

      await expectDangerButtonReadable(page, 'permission-mode-bypass-confirm');
    });
  }
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`the Back to Sessions link of the 404 page takes the accent token and reaches 4.5:1 under the ${theme} theme at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(([adminToken, apiUrl, chosenTheme]) => {
        localStorage.setItem('openfleet.adminToken', adminToken);
        localStorage.setItem('openfleet.apiUrl', apiUrl);
        document.documentElement.setAttribute('data-theme', chosenTheme);
      }, [token, api, theme satisfies Theme]);

      await page.goto('/no-such-page');
      await page.evaluate((chosenTheme) => document.documentElement.setAttribute('data-theme', chosenTheme), theme);

      const backLink = page.getByTestId('not-found').getByRole('link', { name: 'Back to Sessions' });
      await expect(backLink).toBeVisible();
      await expect(backLink).toHaveCSS('color', await resolveTokenFillColor(page, '--accent'));
      expect(await measureContrastRatio(page, '[data-testid="not-found"] a')).toBeGreaterThanOrEqual(MINIMUM_TEXT_CONTRAST);
    });
  }
}

const WARNED_PROJECT = {
  id: '3f2b8c1e-5d4a-4b6e-9a7c-1d2e3f4a5b6c',
  name: 'Fleet',
  docsFolderPath: '/work/fleet-docs',
  docsFolderSharedWith: ['Armada'],
  rowGuardWarning: 'The row guard does not check "done needs a pr_url" on a status column that is not a select.',
};

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`the project warnings of Settings sit inside the project card, aligned with its name and reach 4.5:1 under the ${theme} theme at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(([adminToken, apiUrl, chosenTheme]) => {
        localStorage.setItem('openfleet.adminToken', adminToken);
        localStorage.setItem('openfleet.apiUrl', apiUrl);
        document.documentElement.setAttribute('data-theme', chosenTheme);
      }, [token, api, theme satisfies Theme]);
      await interceptDaemonGet(page, '/api/projects', (route) => fulfillWithJson(route, 200, { items: [WARNED_PROJECT], total: 1, limit: 200, offset: 0 }));

      await page.goto('/settings?tab=general');
      await page.evaluate((chosenTheme) => document.documentElement.setAttribute('data-theme', chosenTheme), theme);

      const card = page.getByTestId('project-card');
      const projectName = card.getByText('Fleet', { exact: true });
      await expect(projectName).toBeVisible();
      for (const warningTestId of ['project-row-guard-warning', 'project-shared-folder-warning']) {
        const warning = card.getByTestId(warningTestId);
        await expect(warning).toBeVisible();
        const warningTextLeft = (await warning.boundingBox())!.x + parseFloat(await warning.evaluate((element) => getComputedStyle(element).paddingLeft));
        expect(warningTextLeft).toBeCloseTo((await projectName.boundingBox())!.x, 0);
        expect(await measureContrastRatio(page, `[data-testid="${warningTestId}"]`)).toBeGreaterThanOrEqual(MINIMUM_TEXT_CONTRAST);
      }
    });
  }
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`the primary button and the uppercase section label reach 4.5:1 under the ${theme} theme at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(([adminToken, apiUrl, chosenTheme]) => {
        localStorage.setItem('openfleet.adminToken', adminToken);
        localStorage.setItem('openfleet.apiUrl', apiUrl);
        document.documentElement.setAttribute('data-theme', chosenTheme);
      }, [token, api, theme satisfies Theme]);

      await page.goto('/new');
      await page.evaluate((chosenTheme) => document.documentElement.setAttribute('data-theme', chosenTheme), theme);

      await expect(page.getByTestId('new-session-submit')).toBeVisible();
      const primaryButtonRatio = await measureContrastRatio(page, '[data-testid="new-session-submit"]');
      const sectionLabelRatio = await measureContrastRatio(page, '.of-section-title');

      expect(primaryButtonRatio).toBeGreaterThanOrEqual(MINIMUM_TEXT_CONTRAST);
      expect(sectionLabelRatio).toBeGreaterThanOrEqual(MINIMUM_TEXT_CONTRAST);
    });
  }
}
