import { expect, test, type Page } from '@playwright/test';
import { readE2eAdminToken } from '../../../scripts/e2e/e2eHome';

import { api } from './support/daemon';
const token = readE2eAdminToken();

const THEMES = ['light', 'dark'] as const;
const VIEWPORT = { width: 1440, height: 900 };
const ROOT_FONT_PX = 16;

interface Size { height: number; fontSize: number; fontWeight: string; paddingInline: number; borderRadius: number }

async function measure(page: Page, testId: string): Promise<Size> {
  return page.getByTestId(testId).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      fontSize: parseFloat(style.fontSize),
      fontWeight: style.fontWeight,
      paddingInline: parseFloat(style.paddingLeft),
      borderRadius: parseFloat(style.borderTopLeftRadius),
    };
  });
}

for (const theme of THEMES) {
  test(`buttons and the kind badge keep the design sizes under the ${theme} theme at 1440×900`, async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await page.addInitScript(([adminToken, apiUrl, chosenTheme]) => {
      localStorage.setItem('openfleet.adminToken', adminToken);
      localStorage.setItem('openfleet.apiUrl', apiUrl);
      document.documentElement.setAttribute('data-theme', chosenTheme);
    }, [token, api, theme]);

    await page.goto('/components');
    await page.evaluate((chosenTheme) => document.documentElement.setAttribute('data-theme', chosenTheme), theme);
    await expect(page.getByTestId('sheet-btn-primary')).toBeVisible();

    const primary = await measure(page, 'sheet-btn-primary');
    const compact = await measure(page, 'sheet-btn-compact');
    const badge = await page.getByTestId('kind-badge').first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, fontSize: parseFloat(style.fontSize), fontWeight: style.fontWeight, borderRadius: parseFloat(style.borderTopLeftRadius) };
    });

    expect(primary).toMatchObject({ height: 1.75 * ROOT_FONT_PX, fontSize: 0.75 * ROOT_FONT_PX, fontWeight: '400', paddingInline: 0.75 * ROOT_FONT_PX, borderRadius: 0.375 * ROOT_FONT_PX });
    expect(compact).toMatchObject({ height: 1.5 * ROOT_FONT_PX, fontSize: 0.6875 * ROOT_FONT_PX, fontWeight: '400', paddingInline: 0.5 * ROOT_FONT_PX, borderRadius: 0.375 * ROOT_FONT_PX });
    expect(badge).toEqual({ height: 1 * ROOT_FONT_PX, fontSize: 0.625 * ROOT_FONT_PX, fontWeight: '400', borderRadius: 0.25 * ROOT_FONT_PX });
  });
}
