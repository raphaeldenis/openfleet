import { expect, test, type Page } from '@playwright/test';
import { readE2eAdminToken } from '../../../scripts/e2e/e2eHome';

const api = 'http://127.0.0.1:7332';
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
