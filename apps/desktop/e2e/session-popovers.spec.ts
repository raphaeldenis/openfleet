import { expect, test, type Page } from '@playwright/test';
import { signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();

const RUNGS = ['haiku', 'sonnet', 'opus', 'fable'];
const PERMISSION_MODES_WITH_BYPASS_LAST = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const BYPASS_CONFIRM_TITLE = 'Turn off permission checks for this session?';

async function openSessionWithDetails(page: Page, sessionId: string): Promise<void> {
  await signInAsAdmin(page);
  await page.goto(`/session/${sessionId}`);
  await page.getByTestId('session-header-toggle').click();
}

test('the model popover lists the four rungs, explains a switch and closes on Escape with focus back on its trigger', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Models', model: 'sonnet' });
  await session.hooks.announceIdle();
  await openSessionWithDetails(page, session.id);
  const trigger = page.getByRole('button', { name: /^Model: / });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  await trigger.click();

  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const rungs = page.getByRole('listbox', { name: 'Model' }).getByRole('option');
  await expect(rungs).toContainText(RUNGS);
  await expect(page.getByText('Rungs · mapped in Settings → Models')).toBeVisible();
  await expect(page.getByText('Switching restarts this session on the new model with its history, ~3 s. Never a silent in-place swap.')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(page.getByRole('listbox', { name: 'Model' })).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
});

test('the permission popover lists the six modes with bypassPermissions last and flagged', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Modes' });
  await session.hooks.announceIdle();
  await openSessionWithDetails(page, session.id);

  await page.getByRole('button', { name: /^Permission mode: / }).click();

  const modes = page.getByRole('listbox', { name: 'Permission mode' }).getByRole('option');
  await expect(modes).toHaveCount(PERMISSION_MODES_WITH_BYPASS_LAST.length);
  for (const [index, mode] of PERMISSION_MODES_WITH_BYPASS_LAST.entries()) {
    await expect(modes.nth(index)).toContainText(mode);
  }
  await expect(page.getByText('Changing the mode applies on the next turn (harness restarts if it must).')).toBeVisible();
});

test('choosing bypassPermissions asks for a confirmation whose safe answer has the focus and changes nothing', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Bypass declined' });
  await session.hooks.announceIdle();
  await openSessionWithDetails(page, session.id);
  const trigger = page.getByRole('button', { name: /^Permission mode: / });
  await trigger.click();

  await page.getByRole('option', { name: /bypassPermissions/ }).click();

  const confirmation = page.getByRole('alertdialog', { name: 'Turn off permission checks' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(BYPASS_CONFIRM_TITLE);
  await expect(confirmation).toContainText('Gates stop appearing in the Inbox and the Audit log is the only record. It applies on the next turn.');
  await expect(confirmation.getByRole('button', { name: 'Turn off checks' })).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Keep asking' })).toBeFocused();

  await confirmation.getByRole('button', { name: 'Keep asking' }).click();

  await expect(confirmation).toHaveCount(0);
  await expect(trigger).toContainText('inherited');
  await expect(trigger).toBeFocused();
});

test('confirming the bypass switches the session to bypassPermissions and flags the trigger', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Bypass confirmed' });
  await session.hooks.announceIdle();
  await openSessionWithDetails(page, session.id);
  await page.getByRole('button', { name: /^Permission mode: / }).click();
  await page.getByRole('option', { name: /bypassPermissions/ }).click();

  await page.getByRole('button', { name: 'Turn off checks' }).click();

  await expect(page.getByTestId('permission-mode')).toHaveText(/bypassPermissions/);
  await expect(page.getByTestId('permission-mode')).toHaveAttribute('data-warning', '1');
});
