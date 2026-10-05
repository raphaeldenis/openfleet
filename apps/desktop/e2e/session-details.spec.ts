import { expect, test, type Locator } from '@playwright/test';
import { sessionStateLabel, signInAsAdmin, sizeOf, useFakeSessions } from './support/daemon';

const COMPACT_BUTTON_HEIGHT_PX = 24;
const COMPACT_BUTTON_FONT_PX = 11;
const ESCAPE_KEY = '\x1b';

const fakeSessions = useFakeSessions();

const colorOf = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).color);
const borderColorOf = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).borderTopColor);

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

test('the Session tab of the right panel shows the identity, the state and every control of the open session', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Everything', model: 'sonnet' });
  await session.hooks.announceIdle();

  await page.goto(`/session/${session.id}`);

  await expect(page.getByTestId('right-panel-tab-session')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('session-name-input')).toHaveValue('Everything');
  await expect(sessionStateLabel(page)).toHaveText('idle');
  await expect(page.getByTestId('session-harness')).toHaveText('fake');
  await expect(page.getByTestId('current-model')).toBeVisible();
  await expect(page.getByTestId('permission-mode')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write handoff' })).toBeVisible();
  await expect(page.getByTestId('session-close')).toBeVisible();
});

test('the session view has no header of its own: the sidebar names the session and the right panel holds its details', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Headerless' });
  await session.hooks.announceIdle();

  await page.goto(`/session/${session.id}`);

  await expect(page.getByTestId('session-view')).toBeVisible();
  await expect(page.getByTestId('session-header')).toHaveCount(0);
  await expect(page.getByTestId('state-panel-toggle')).toHaveCount(0);
  await expect(page.getByTestId(`session-${session.id}`)).toHaveAttribute('aria-current', 'true');
});

test('the state chip names its state in the foreground colour and keeps the state colour on its glyph', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Chip colours' });
  await session.hooks.announceIdle();

  await page.goto(`/session/${session.id}`);

  const chip = page.getByTestId('session-details').getByTestId('state-chip');
  await expect(sessionStateLabel(page)).toHaveText('idle');
  const labelColor = await colorOf(sessionStateLabel(page));
  const glyphColor = await colorOf(chip.locator('span').first());
  const foregroundColor = await colorOf(page.getByTestId('session-name-input'));
  expect(labelColor).toBe(foregroundColor);
  expect(glyphColor).not.toBe(foregroundColor);
});

test('Interrupt is one compact amber control in the terminal tab bar, and only while generating', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Busy' });
  await session.hooks.announceIdle();
  await page.goto(`/session/${session.id}`);
  const interrupt = page.getByTestId('terminal-tab-bar').getByRole('button', { name: 'Interrupt' });
  await expect(sessionStateLabel(page)).toHaveText('idle');
  await expect(interrupt).toHaveCount(0);

  await session.hooks.startTurn();

  await expect(sessionStateLabel(page)).toHaveText('generating');
  await expect(page.getByRole('button', { name: 'Interrupt' })).toHaveCount(1);
  await expect(interrupt).toHaveAttribute('title', 'Interrupt the current turn (esc)');
  expect(await sizeOf(interrupt)).toEqual({ height: COMPACT_BUTTON_HEIGHT_PX, fontSize: COMPACT_BUTTON_FONT_PX });
  const amberBorder = await borderColorOf(interrupt);
  const glyphColor = await colorOf(interrupt.locator('span[aria-hidden="true"]'));
  const labelColor = await colorOf(interrupt);
  expect(glyphColor).toBe(amberBorder);
  expect(labelColor).not.toBe(amberBorder);

  await session.hooks.endTurn();

  await expect(sessionStateLabel(page)).toHaveText('idle');
  await expect(interrupt).toHaveCount(0);
});

test('Interrupt stays reachable while the right panel is collapsed', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Collapsed panel' });
  await session.hooks.announceIdle();
  await session.hooks.startTurn();
  await signInAsAdmin(page, { rightPanel: 'closed' });

  await page.goto(`/session/${session.id}`);

  await expect(page.getByTestId('right-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();
});

test('pressing Interrupt sends Escape to the session and shows no error', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Escapes' });
  await session.hooks.announceIdle();
  await session.hooks.startTurn();
  await page.goto(`/session/${session.id}`);
  const interrupt = page.getByRole('button', { name: 'Interrupt' });
  await expect(interrupt).toBeVisible();

  const inputRequest = page.waitForRequest((sent) => sent.url().endsWith(`/api/sessions/${session.id}/input`) && sent.method() === 'POST');
  await interrupt.click();

  expect((await inputRequest).postDataJSON()).toEqual({ data: ESCAPE_KEY });
  await expect(page.getByTestId('session-action-error')).toHaveCount(0);
});

test('the collapsed right panel opens on the Session tab from its rail button', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Open from rail' });
  await session.hooks.announceIdle();
  await signInAsAdmin(page, { rightPanel: 'closed' });
  await page.goto(`/session/${session.id}`);

  await page.getByRole('button', { name: 'Show the right panel' }).click();

  await expect(page.getByTestId('right-panel-tab-session')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('session-name-input')).toHaveValue('Open from rail');
});
