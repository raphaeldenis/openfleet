import { expect, test, type Locator } from '@playwright/test';
import { e2eHomePath } from '../../../scripts/e2e/e2eHome';
import { signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();
const OUTLET_MARGIN = 8;
const VIEWPORTS = [{ width: 1200, height: 800 }, { width: 1440, height: 900 }];

async function expectInsideOutlet({ panel, outlet }: { panel: Locator; outlet: Locator }): Promise<void> {
  await expect(panel).toBeVisible();
  await expect.poll(async () => {
    const panelBox = await panel.boundingBox();
    const outletBox = await outlet.boundingBox();
    if (!panelBox || !outletBox) return false;
    const isLeftInside = panelBox.x >= outletBox.x + OUTLET_MARGIN - 1;
    const isRightInside = panelBox.x + panelBox.width <= outletBox.x + outletBox.width - OUTLET_MARGIN + 1;
    return isLeftInside && isRightInside;
  }).toBe(true);
  expect(await outlet.evaluate((element) => element.scrollLeft)).toBe(0);
}

for (const viewport of VIEWPORTS) {
  for (const theme of ['light', 'dark'] as const) {
    test(`permission and bypass stay inside the outlet at ${viewport.width}px in ${theme}`, async ({ page, request }) => {
      await page.setViewportSize(viewport);
      const session = await fakeSessions.create(request, { name: 'Popover bounds', directory: e2eHomePath() });
      await session.hooks.announceIdle();
      await signInAsAdmin(page, { theme });
      await page.goto(`/session/${session.id}`);
      await page.getByTestId('session-header-toggle').click();
      const trigger = page.getByTestId('permission-mode-trigger');
      const outlet = page.getByTestId('app-outlet');
      await expect(page.getByTestId('session-header-toggle')).toHaveAttribute('aria-expanded', 'true');
      await expect(trigger).toBeVisible();
      const headerBoxBefore = await page.getByTestId('session-header').boundingBox();

      await trigger.click();

      const permissionPanel = page.getByRole('listbox', { name: 'Permission mode' }).locator('..');
      await expectInsideOutlet({ panel: permissionPanel, outlet });
      await page.getByRole('option', { name: /bypassPermissions/ }).click();
      const confirmation = page.getByRole('alertdialog', { name: 'Turn off permission checks' });
      await expectInsideOutlet({ panel: confirmation, outlet });
      await expect(page.getByRole('button', { name: 'Keep asking' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Turn off checks' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(page.getByRole('button', { name: 'Keep asking' })).toBeFocused();
      expect(await page.getByTestId('session-header').boundingBox()).toEqual(headerBoxBefore);
      await page.keyboard.press('Escape');
      await expect(confirmation).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }
}

test('light starting and closed glyphs reach 3:1 on their tinted panel, sunk and side surfaces', async ({ page }) => {
  await signInAsAdmin(page, { theme: 'light' });
  await page.goto('/settings');
  const ratios = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const luminance = (channels: number[]) => {
      const linear = channels.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    };
    return ['--panel', '--sunk', '--side'].map((surface) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--state-closed)';
      probe.style.backgroundColor = `var(${surface})`;
      document.body.append(probe);
      const style = getComputedStyle(probe);
      context.fillStyle = style.backgroundColor;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = `color-mix(in oklch, ${style.color} 14%, transparent)`;
      context.fillRect(0, 0, 1, 1);
      const background = luminance(Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3));
      context.fillStyle = style.color;
      context.fillRect(0, 0, 1, 1);
      const foreground = luminance(Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3));
      probe.remove();
      return { surface, ratio: (background + 0.05) / (foreground + 0.05) };
    });
  });
  await test.info().attach('glyph-contrast-ratios', { body: JSON.stringify(ratios), contentType: 'application/json' });
  for (const { surface, ratio } of ratios) {
    expect(ratio, surface).toBeGreaterThanOrEqual(3);
  }
});
