import { expect, test } from '@playwright/test';
import { api, adminHeaders, signInAsAdmin, sizeOf, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();

const STANDARD_BUTTON = { height: 28, fontSize: 12 };
const COMPACT_BUTTON = { height: 24, fontSize: 11 };
const FAST_PULSE_SECONDS = 1;

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

test('a permission gate in the Inbox offers its decision pair at the standard button size', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Gate keeper' });
  await session.hooks.announceIdle();
  await page.goto('/inbox');

  const decision = session.hooks.requestPermission({ command: 'rm -rf dist' });

  const gateCard = page.getByTestId('inbox-gate-card').filter({ hasText: 'rm -rf dist' });
  await expect(gateCard).toBeVisible();
  await expect(gateCard.getByTestId('inbox-gate-session')).toHaveText('Gate keeper');
  expect(await sizeOf(gateCard.getByRole('button', { name: 'Approve' }))).toEqual(STANDARD_BUTTON);
  expect(await sizeOf(gateCard.getByRole('button', { name: 'Deny' }))).toEqual(STANDARD_BUTTON);

  await gateCard.getByRole('button', { name: 'Approve' }).click();

  expect(await decision).toBe('allow');
  await expect(gateCard).toHaveCount(0);
});

test('an issue card keeps Copy details and Dismiss compact, and Dismiss keeps the focus inside the Inbox', async ({ page, request }) => {
  const manager = await fakeSessions.create(request, { name: 'Failing pulses', emoji: '🧭', manager: { pulseSeconds: FAST_PULSE_SECONDS, childrenCap: 1, mission: 'Fail one pulse' } });
  await request.post(`${api}/api/managers/${manager.id}/fail-next-pulses`, { headers: adminHeaders, data: { count: 1 } });
  await page.goto('/inbox');

  await manager.hooks.announceIdle();

  const issueCard = page.getByTestId('inbox-issue').filter({ hasText: 'Failing pulses' });
  await expect(issueCard).toBeVisible();
  await expect(issueCard.getByTestId('inbox-issue-copy')).toContainText('unexpected error');
  const copyDetails = issueCard.getByRole('button', { name: 'Copy details' });
  const dismiss = issueCard.getByRole('button', { name: 'Dismiss' });
  expect(await sizeOf(copyDetails)).toEqual(COMPACT_BUTTON);
  expect(await sizeOf(dismiss)).toEqual(COMPACT_BUTTON);

  await dismiss.click();

  await expect(issueCard).toHaveCount(0);
  await expect(page.getByTestId('inbox').locator(':focus')).toHaveCount(1);
});

test('the Inbox is one list opened on All, with a Questions filter and no tabs', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Gate keeper' });
  await session.hooks.announceIdle();
  await page.goto('/inbox');
  const decision = session.hooks.requestPermission({ command: 'ls' });
  const gateCard = page.getByTestId('inbox-gate-card').filter({ hasText: 'ls' });
  await expect(page.getByTestId('inbox-filter-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(gateCard).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);

  await page.getByTestId('inbox-filter-questions').click();

  await expect(page.getByTestId('inbox-filter-questions')).toHaveAttribute('aria-pressed', 'true');
  await expect(gateCard).toHaveCount(0);

  await page.getByTestId('inbox-filter-all').click();
  await gateCard.getByRole('button', { name: 'Deny' }).click();
  expect(await decision).toBe('deny');
});
