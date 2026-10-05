import { expect, test, type Page } from '@playwright/test';
import { signInAsAdmin, useFakeSessions } from './support/daemon';

const ONE_TERMINAL_CELL_PLUS_SCROLLBAR_PX = 24;
const WIDTH_TOLERANCE_PX = 2;
const PAGES_WITHOUT_SELECTION = ['/', '/inbox', '/notes', '/tables', '/project', '/settings', '/new'];
const MANAGER_SPEC = { pulseSeconds: 3600, childrenCap: 2, mission: 'Watch the fleet' };

const fakeSessions = useFakeSessions();

const rightPanel = (page: Page) => page.getByTestId('right-panel');
const railButton = (page: Page) => page.getByTestId('right-panel-rail');
const widthOf = (page: Page, testId: string) => page.getByTestId(testId).evaluate((element) => element.getBoundingClientRect().width);
const renderedScreenWidthOf = (page: Page) => page.locator('[data-testid="terminal"] .xterm-screen').evaluate((element) => element.getBoundingClientRect().width);

async function openAppAt(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId('app-shell')).toBeVisible();
}

for (const rememberedState of ['open', 'closed'] as const) {
  test(`pages without a selected session or manager have no panel, no rail button and the full width, with the panel remembered ${rememberedState}`, async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 940 });
    await signInAsAdmin(page, { rightPanel: rememberedState });

    for (const url of PAGES_WITHOUT_SELECTION) {
      await openAppAt(page, url);

      await expect(rightPanel(page), url).toHaveCount(0);
      await expect(railButton(page), url).toHaveCount(0);
      await page.keyboard.press('Alt+Meta+B');
      await expect(rightPanel(page), url).toHaveCount(0);
      const widthLeftBySidebar = (await widthOf(page, 'app-shell')) - (await widthOf(page, 'app-nav'));
      expect(await widthOf(page, 'app-outlet'), url).toBeGreaterThanOrEqual(widthLeftBySidebar - WIDTH_TOLERANCE_PX);
    }
  });
}

test('a selected session and a selected manager each have the panel, open for a user who never chose', async ({ page, request }) => {
  await page.setViewportSize({ width: 1500, height: 940 });
  await signInAsAdmin(page, { rightPanel: 'unchosen' });
  const session = await fakeSessions.create(request, { name: 'Selected' });
  const manager = await fakeSessions.create(request, { name: 'Lead', manager: MANAGER_SPEC });

  await openAppAt(page, `/session/${session.id}`);
  await expect(rightPanel(page)).toBeVisible();

  await openAppAt(page, `/manager/${manager.id}`);
  await expect(rightPanel(page)).toBeVisible();
});

test('the panel leaves with the selection and returns with the open state and the tab it had', async ({ page, request }) => {
  await page.setViewportSize({ width: 1500, height: 940 });
  await signInAsAdmin(page);
  const session = await fakeSessions.create(request, { name: 'Round trip' });
  await session.hooks.announceIdle();
  await openAppAt(page, `/session/${session.id}`);
  await page.getByTestId('right-panel-tab-todos').click();

  await page.getByTestId('nav-notes').click();
  await expect(rightPanel(page)).toHaveCount(0);
  await page.getByTestId(`session-${session.id}`).click();

  await expect(rightPanel(page)).toBeVisible();
  await expect(page.getByTestId('right-panel-tab-todos')).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('right-panel-collapse').click();
  await page.getByTestId('nav-notes').click();
  await page.getByTestId(`session-${session.id}`).click();

  await expect(rightPanel(page)).toHaveCount(0);
  await expect(railButton(page)).toBeVisible();
});

test('the terminal refits when the panel appears with the selection and disappears with it', async ({ page, request }) => {
  await page.setViewportSize({ width: 1500, height: 940 });
  await signInAsAdmin(page);
  const session = await fakeSessions.create(request, { name: 'Refit on selection' });
  await session.hooks.announceIdle();
  const isRenderedScreenFillingHost = async () => (await widthOf(page, 'terminal')) - (await renderedScreenWidthOf(page)) <= ONE_TERMINAL_CELL_PLUS_SCROLLBAR_PX;
  await openAppAt(page, `/session/${session.id}`);
  await expect(page.locator('[data-testid="terminal"] .xterm-screen')).toBeVisible();
  await expect(rightPanel(page)).toBeVisible();
  await expect.poll(isRenderedScreenFillingHost).toBe(true);

  await page.getByTestId('nav-notes').click();
  await page.getByTestId(`session-${session.id}`).click();

  await expect(rightPanel(page)).toBeVisible();
  await expect(page.locator('[data-testid="terminal"] .xterm-screen')).toBeVisible();
  await expect.poll(isRenderedScreenFillingHost).toBe(true);
});
