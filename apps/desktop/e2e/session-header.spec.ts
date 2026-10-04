import { expect, test, type Locator } from '@playwright/test';
import { headerStateLabel, signInAsAdmin, sizeOf, useFakeSessions } from './support/daemon';

const COMPACT_BUTTON_HEIGHT_PX = 24;
const STANDARD_BUTTON_HEIGHT_PX = 28;
const COMPACT_BUTTON_FONT_PX = 11;
const ESCAPE_KEY = '\x1b';

const fakeSessions = useFakeSessions();

const colorOf = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).color);
const borderColorOf = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).borderTopColor);

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

test('the session header is collapsed to its identity line and opens its details on demand', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Collapsed', model: 'sonnet' });
  await session.hooks.announceIdle();

  await page.goto(`/session/${session.id}`);

  const detailsToggle = page.getByTestId('session-header-toggle');
  await expect(page.getByTestId('session-name-input')).toHaveValue('Collapsed');
  await expect(headerStateLabel(page)).toHaveText('idle');
  await expect(detailsToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('session-harness')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Write handoff' })).toHaveCount(0);
  await expect(page.getByTestId('session-close')).toHaveCount(0);

  await detailsToggle.click();

  await expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('session-harness')).toHaveText('fake');
  await expect(page.getByRole('button', { name: 'Write handoff' })).toBeVisible();
  await expect(page.getByTestId('session-close')).toBeVisible();
});

test('the state chip names its state in the foreground colour and keeps the state colour on its glyph', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Chip colours' });
  await session.hooks.announceIdle();

  await page.goto(`/session/${session.id}`);

  const chip = page.getByTestId('session-header').getByTestId('state-chip');
  await expect(headerStateLabel(page)).toHaveText('idle');
  const labelColor = await colorOf(headerStateLabel(page));
  const glyphColor = await colorOf(chip.locator('span').first());
  const foregroundColor = await colorOf(page.getByTestId('session-name-input'));
  expect(labelColor).toBe(foregroundColor);
  expect(glyphColor).not.toBe(foregroundColor);
});

test('Interrupt is one amber control, compact while the header is collapsed, standard when it is open, and only while generating', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Busy' });
  await session.hooks.announceIdle();
  await page.goto(`/session/${session.id}`);
  const interrupt = page.getByRole('button', { name: 'Interrupt' });
  await expect(headerStateLabel(page)).toHaveText('idle');
  await expect(interrupt).toHaveCount(0);

  await session.hooks.startTurn();

  await expect(headerStateLabel(page)).toHaveText('generating');
  await expect(interrupt).toHaveCount(1);
  await expect(interrupt).toHaveAttribute('title', 'Interrupt the current turn (esc)');
  const collapsedSize = await sizeOf(interrupt);
  expect(collapsedSize).toEqual({ height: COMPACT_BUTTON_HEIGHT_PX, fontSize: COMPACT_BUTTON_FONT_PX });
  const amberBorder = await borderColorOf(interrupt);
  const glyphColor = await colorOf(interrupt.locator('span[aria-hidden="true"]'));
  const labelColor = await colorOf(interrupt);
  expect(glyphColor).toBe(amberBorder);
  expect(labelColor).toBe(await colorOf(page.getByTestId('session-name-input')));
  expect(labelColor).not.toBe(amberBorder);

  await page.getByTestId('session-header-toggle').click();

  await expect(interrupt).toHaveCount(1);
  await expect.poll(async () => (await sizeOf(interrupt)).height).toBe(STANDARD_BUTTON_HEIGHT_PX);

  await session.hooks.endTurn();

  await expect(headerStateLabel(page)).toHaveText('idle');
  await expect(interrupt).toHaveCount(0);
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
