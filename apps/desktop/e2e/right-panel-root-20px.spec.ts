import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAsAdmin, useFakeSessions } from './support/daemon';

const ROOT_FONT_SIZE = '20px';
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
];
const THEMES = ['light', 'dark'] as const;

const fakeSessions = useFakeSessions();

const documentScrollsHorizontally = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function expectFullyInsideViewport(page: Page, element: Locator, description: string) {
  const box = await element.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error(`${description} has no bounding box`);
  expect(box.x, `${description} left edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${description} right edge`).toBeLessThanOrEqual(viewport.width);
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test(`the open right panel and its tabs stay inside the viewport with a ${ROOT_FONT_SIZE} root font, ${theme} theme, ${viewport.width}×${viewport.height}`, async ({ page, request }) => {
      await page.setViewportSize(viewport);
      await signInAsAdmin(page, { theme });
      const session = await fakeSessions.create(request, { name: 'Large root font' });
      await session.hooks.announceIdle();
      await page.goto(`/session/${session.id}`);
      await expect(page.getByTestId('right-panel')).toBeVisible();

      await page.evaluate((fontSize) => { document.documentElement.style.fontSize = fontSize; }, ROOT_FONT_SIZE);

      await expect.poll(() => documentScrollsHorizontally(page)).toBe(false);
      await expectFullyInsideViewport(page, page.getByTestId('right-panel'), 'right panel');
      await expectFullyInsideViewport(page, page.getByTestId('right-panel').locator('.tabs'), 'tabs header');
    });
  }
}
