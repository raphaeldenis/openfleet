import { expect, test, type Locator, type Page } from '@playwright/test';
import { exitFakeCli, sessionStateLabel, signInAsAdmin, useFakeSessions } from './support/daemon';

const MINIMUM_READABLE_CONTRAST = 4.5;
const SINGLE_LINE_HEIGHT_FACTOR = 1.6;
const PANEL_WIDTHS = [1200, 1440];
const THEMES = ['light', 'dark'] as const;

const fakeSessions = useFakeSessions();

interface Box { top: number; bottom: number; left: number; right: number; height: number }

const boxOf = (locator: Locator): Promise<Box> => locator.evaluate((element) => element.getBoundingClientRect().toJSON());

async function openSessionWithPanel(page: Page, request: Parameters<typeof fakeSessions.create>[0], theme: 'light' | 'dark' = 'dark') {
  await signInAsAdmin(page, { theme });
  const session = await fakeSessions.create(request, { name: 'Chrome check' });
  await session.hooks.announceIdle();
  await page.goto(`/session/${session.id}`);
  await expect(page.getByTestId('right-panel')).toBeVisible();
  return session;
}

const relativeLuminance = ([red, green, blue]: number[]) => {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const unit = channel! / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const contrastBetween = (first: number[], second: number[]) => {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
};

const channelsOf = (cssColor: string) => (cssColor.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);

for (const width of PANEL_WIDTHS) {
  test(`the right panel tab row is not clipped and no label wraps at ${width}px wide`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSessionWithPanel(page, request);

    const head = await boxOf(page.getByTestId('right-panel').locator('header'));
    const tabList = await boxOf(page.getByRole('tablist', { name: 'Right panel' }));
    for (const key of ['session', 'sessions', 'usage', 'todos']) {
      const tab = page.getByTestId(`right-panel-tab-${key}`);
      const tabBox = await boxOf(tab);
      expect(tabBox.top, `${key} top`).toBeGreaterThanOrEqual(head.top);
      expect(tabBox.bottom, `${key} bottom`).toBeLessThanOrEqual(head.bottom);
      expect(tabBox.right, `${key} right`).toBeLessThanOrEqual(tabList.right);
      await expect(tab).toBeVisible();
      const labelsFitOneLine = await tab.locator('span').evaluateAll((spans, factor) => spans.every((span) => span.getBoundingClientRect().height <= parseFloat(getComputedStyle(span).fontSize) * factor), SINGLE_LINE_HEIGHT_FACTOR);
      expect(labelsFitOneLine, `${key} labels on one line`).toBe(true);
    }
    await expect(page.getByTestId('right-panel-tab-sessions')).toContainText('Coming soon');
    await expect(page.getByTestId('right-panel-tab-usage')).toContainText('Coming soon');
  });
}

for (const theme of THEMES) {
  test(`the terminal takes its colours from the ${theme} design tokens and stays readable`, async ({ page, request }) => {
    await openSessionWithPanel(page, request, theme);
    await expect(page.locator('[data-testid="terminal"] .xterm-screen')).toBeVisible();

    const colours = await page.evaluate(() => {
      const tokens = getComputedStyle(document.documentElement);
      const probe = document.createElement('span');
      const resolve = (token: string) => { probe.style.color = tokens.getPropertyValue(token); document.body.append(probe); const resolved = getComputedStyle(probe).color; probe.remove(); return resolved; };
      const viewport = document.querySelector('[data-testid="terminal"] .xterm-scrollable-element')!;
      const rows = document.querySelector('[data-testid="terminal"] .xterm-rows')!;
      return {
        tokenBackground: resolve('--term-bg'), tokenForeground: resolve('--term-fg'),
        terminalBackground: getComputedStyle(viewport).backgroundColor, terminalForeground: getComputedStyle(rows).color,
      };
    });

    expect(colours.terminalBackground).toBe(colours.tokenBackground);
    expect(colours.terminalForeground).toBe(colours.tokenForeground);
    expect(contrastBetween(channelsOf(colours.terminalForeground), channelsOf(colours.terminalBackground))).toBeGreaterThanOrEqual(MINIMUM_READABLE_CONTRAST);
  });
}

test('the terminal follows the theme toggle without a reload', async ({ page, request }) => {
  await openSessionWithPanel(page, request, 'dark');
  const viewport = page.locator('[data-testid="terminal"] .xterm-scrollable-element');
  const darkBackground = await viewport.evaluate((element) => getComputedStyle(element).backgroundColor);

  await page.getByTestId('sidebar-footer').getByTestId('theme-toggle').click();

  await expect.poll(() => viewport.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(darkBackground);
});

test('sidebar nav links are never underlined, at rest, hovered, focused or selected', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/inbox');
  const links = page.locator('a.nav-item');
  await expect(links.first()).toBeVisible();
  const underlineOf = (link: Locator) => link.evaluate((element) => getComputedStyle(element).textDecorationLine);

  for (const link of await links.all()) expect(await underlineOf(link)).toBe('none');
  for (const link of await links.all()) {
    await link.hover();
    expect(await underlineOf(link)).toBe('none');
    await link.focus();
    expect(await underlineOf(link)).toBe('none');
  }
  await expect(page.locator('a.nav-item.active')).toHaveCount(1);
  expect(await underlineOf(page.locator('a.nav-item.active'))).toBe('none');
});

test('a closed session offers Resume in its Session tab and its state chip carries no running timer', async ({ page, request }) => {
  const session = await openSessionWithPanel(page, request);
  await expect(sessionStateLabel(page)).toHaveText('idle');
  await expect(page.getByTestId('session-details').getByTestId('state-chip-elapsed')).toBeVisible();

  await exitFakeCli(request, session.id, { code: 0 });

  await expect(sessionStateLabel(page)).toHaveText('closed · exit 0');
  const details = page.getByTestId('session-details');
  await expect(details.getByRole('button', { name: /Resume/ })).toBeEnabled();
  await expect(details.getByTestId('state-chip-elapsed')).toHaveCount(0);
  await expect(page.getByTestId('state-panel-body')).toContainText('No state was recorded before this session closed.');
});
