import { expect, test, type Page } from '@playwright/test';
import { signInAsAdmin, useFakeSessions } from './support/daemon';

const WIDTH_TOLERANCE_PX = 1;
const TERMINAL_AREA_PADDING_PX = 16;
const ONE_TERMINAL_CELL_PLUS_SCROLLBAR_PX = 24;
const RIGHT_PANEL_STORAGE_KEY = 'openfleet.rightPanel.open';

const viewports = [{ width: 1500, height: 940 }, { width: 1200, height: 800 }];
const themes = ['light', 'dark'] as const;
const panelStates = [{ name: 'collapsed', isOpen: false }, { name: 'open', isOpen: true }];

const fakeSessions = useFakeSessions();

const widthOf = (page: Page, testId: string) => page.getByTestId(testId).evaluate((element) => element.getBoundingClientRect().width);
const sessionColumnWidthOf = (page: Page) => page.locator('of-session-view').evaluate((element) => element.getBoundingClientRect().width);
const terminalHostWidthOf = (page: Page) => widthOf(page, 'terminal');
const renderedScreenWidthOf = (page: Page) => page.locator('[data-testid="terminal"] .xterm-screen').evaluate((element) => element.getBoundingClientRect().width);

async function scrollOffsetsOf(page: Page) {
  return page.evaluate(() => ({
    document: document.scrollingElement?.scrollLeft ?? 0,
    shell: document.querySelector('[data-testid="app-shell"]')?.scrollLeft ?? 0,
    body: document.body.scrollLeft,
    overflowsHorizontally: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
}

async function openSessionWithPanel(page: Page, { sessionId, isPanelOpen }: { sessionId: string; isPanelOpen: boolean }) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [RIGHT_PANEL_STORAGE_KEY, String(isPanelOpen)] as const);
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByTestId('terminal')).toBeVisible();
  await expect(page.locator('[data-testid="terminal"] .xterm-screen')).toBeVisible();
}

for (const viewport of viewports) {
  for (const theme of themes) {
    for (const panel of panelStates) {
      test(`the session fills the width left by the sidebar and the ${panel.name} right panel, unscrolled, in ${theme} at ${viewport.width}×${viewport.height}`, async ({ page, request }) => {
        await page.setViewportSize(viewport);
        await signInAsAdmin(page, { theme });
        const session = await fakeSessions.create(request, { name: 'Layout' });
        await session.hooks.announceIdle();

        await openSessionWithPanel(page, { sessionId: session.id, isPanelOpen: panel.isOpen });

        const outletWidth = await widthOf(page, 'app-outlet');
        expect(await sessionColumnWidthOf(page)).toBeGreaterThanOrEqual(outletWidth - WIDTH_TOLERANCE_PX);
        expect(await terminalHostWidthOf(page)).toBeGreaterThanOrEqual(outletWidth - TERMINAL_AREA_PADDING_PX - WIDTH_TOLERANCE_PX);
        expect(await scrollOffsetsOf(page)).toEqual({ document: 0, shell: 0, body: 0, overflowsHorizontally: false });
      });
    }
  }
}

const VERTICAL_TOLERANCE_PX = 1;
const ONE_TERMINAL_ROW_PX = 24;

async function verticalGapsAroundTerminal(page: Page) {
  return page.evaluate(() => {
    const sessionView = document.querySelector('of-session-view')!.getBoundingClientRect();
    const terminalHost = document.querySelector('[data-testid="terminal"]')!.getBoundingClientRect();
    const renderedScreen = document.querySelector('[data-testid="terminal"] .xterm-screen')!.getBoundingClientRect();
    return {
      aboveHost: terminalHost.top - sessionView.top,
      belowHost: sessionView.bottom - terminalHost.bottom,
      unusedByRows: terminalHost.bottom - renderedScreen.bottom,
    };
  });
}

for (const viewport of viewports) {
  for (const panel of panelStates) {
    test(`the terminal fills the session view top to bottom with the ${panel.name} right panel at ${viewport.width}×${viewport.height}`, async ({ page, request }) => {
      await page.setViewportSize(viewport);
      await signInAsAdmin(page);
      const session = await fakeSessions.create(request, { name: 'Vertical' });
      await session.hooks.announceIdle();

      await openSessionWithPanel(page, { sessionId: session.id, isPanelOpen: panel.isOpen });

      await expect.poll(async () => (await verticalGapsAroundTerminal(page)).aboveHost).toBeLessThanOrEqual(VERTICAL_TOLERANCE_PX);
      const gaps = await verticalGapsAroundTerminal(page);
      expect(gaps.belowHost).toBeLessThanOrEqual(VERTICAL_TOLERANCE_PX);
      expect(gaps.unusedByRows).toBeLessThan(ONE_TERMINAL_ROW_PX);
      await expect(page.getByTestId('right-panel-session-toggle')).toBeVisible();
    });
  }
}

test('the shell stays unscrolled after the terminal takes focus', async ({ page, request }) => {
  await page.setViewportSize(viewports[0]!);
  await signInAsAdmin(page);
  const session = await fakeSessions.create(request, { name: 'Focus' });
  await session.hooks.announceIdle();
  await openSessionWithPanel(page, { sessionId: session.id, isPanelOpen: false });

  await page.locator('[data-testid="terminal"] .xterm-helper-textarea').focus();
  await page.getByTestId('terminal').click();

  expect(await scrollOffsetsOf(page)).toEqual({ document: 0, shell: 0, body: 0, overflowsHorizontally: false });
});

test('the terminal refits to the width the right panel gives back when it collapses and takes when it opens', async ({ page, request }) => {
  await page.setViewportSize(viewports[0]!);
  await signInAsAdmin(page);
  const session = await fakeSessions.create(request, { name: 'Refit' });
  await session.hooks.announceIdle();
  await openSessionWithPanel(page, { sessionId: session.id, isPanelOpen: false });
  const isRenderedScreenFillingHost = async () => (await terminalHostWidthOf(page)) - (await renderedScreenWidthOf(page)) <= ONE_TERMINAL_CELL_PLUS_SCROLLBAR_PX;
  const collapsedHostWidth = await terminalHostWidthOf(page);

  await page.getByTestId('right-panel-session-toggle').click();

  await expect.poll(() => terminalHostWidthOf(page)).toBeLessThan(collapsedHostWidth);
  await expect.poll(isRenderedScreenFillingHost).toBe(true);

  await page.getByTestId('right-panel-collapse').click();

  await expect.poll(() => terminalHostWidthOf(page)).toBe(collapsedHostWidth);
  await expect.poll(isRenderedScreenFillingHost).toBe(true);
});
