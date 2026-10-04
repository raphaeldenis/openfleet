import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitFakeCli, headerStateLabel, signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();

const REOPEN_FRESH_REASON = 'Not available yet — the daemon cannot relaunch a session without its previous conversation.';

const lifecycleStrip = (page: Page) => page.getByTestId('lifecycle-banner');
const closedCard = (page: Page) => page.getByTestId('session-closed-footer');

async function openSessionThatIsIdle(page: Page, session: { id: string; hooks: { announceIdle(): Promise<void> } }): Promise<void> {
  await signInAsAdmin(page);
  await session.hooks.announceIdle();
  await page.goto(`/session/${session.id}`);
  await expect(headerStateLabel(page)).toHaveText('idle');
}

async function expectReopenFreshUnavailableWithItsReason(page: Page): Promise<void> {
  const reopenFresh = closedCard(page).getByRole('button', { name: 'Reopen fresh' });
  await expect(reopenFresh).toHaveAttribute('aria-disabled', 'true');
  await expect(reopenFresh).toHaveAccessibleDescription(REOPEN_FRESH_REASON);
  await reopenFresh.hover();
  await expect(closedCard(page).getByText(REOPEN_FRESH_REASON)).toBeVisible();
}

test('an agent that exits with an error closes the session with the error strip, the exit code and both actions', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Crashed' });
  await openSessionThatIsIdle(page, session);

  await exitFakeCli(request, session.id, { code: 1 });

  await expect(headerStateLabel(page)).toHaveText('closed');
  await expect(page.getByTestId('session-exit-code')).toHaveText('closed · exit 1');
  await expect(lifecycleStrip(page)).toHaveAttribute('data-variant', 'error');
  await expect(lifecycleStrip(page)).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('lifecycle-title')).toContainText('Agent process exited');
  await expect(page.getByTestId('lifecycle-message')).toHaveText('The agent process ended unexpectedly — reopen the session to resume the conversation.');
  await expect(page.getByTestId('lifecycle-copy-details')).toHaveText('Copy details');
  await expect(page.getByTestId('session-closed-title')).toContainText('Closed · exit 1');
  await expect(closedCard(page)).toHaveAttribute('data-variant', 'error');
  await expect(closedCard(page).getByRole('button', { name: /Resume in worktree/ })).toBeEnabled();
  await expectReopenFreshUnavailableWithItsReason(page);
  await expect(page.getByTestId('composer-input')).toHaveCount(0);
});

test('a session that ends cleanly closes with a neutral card, no strip and the worktree note', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Finished' });
  await openSessionThatIsIdle(page, session);

  await exitFakeCli(request, session.id, { code: 0 });

  await expect(headerStateLabel(page)).toHaveText('closed');
  await expect(page.getByTestId('session-closed-title')).toContainText('Closed · exit 0');
  await expect(closedCard(page)).toContainText('Worktree kept · transcript is read-only.');
  await expect(closedCard(page)).toHaveAttribute('data-variant', 'neutral');
  await expect(lifecycleStrip(page)).toHaveCount(0);
  await expect(closedCard(page).getByRole('button', { name: /Resume in worktree/ })).toBeEnabled();
  await expectReopenFreshUnavailableWithItsReason(page);
});

test('a refused resume closes the session as conversation not found, explains it once and offers no resume', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Lost transcript' });
  await openSessionThatIsIdle(page, session);

  await exitFakeCli(request, session.id, { code: 1, conversationNotFound: true });

  await expect(headerStateLabel(page)).toHaveText('closed');
  await expect(lifecycleStrip(page)).toHaveAttribute('data-variant', 'error');
  await expect(page.getByTestId('lifecycle-title')).toContainText('Conversation not found');
  await expect(page.getByTestId('lifecycle-message')).toHaveText('The transcript for this session is gone; start a new session from its handoff.');
  await expect(page.getByTestId('lifecycle-copy-details')).toBeVisible();
  await expect(page.getByTestId('session-closed-title')).toHaveText(/Not running/);
  await expect(closedCard(page)).not.toContainText('Worktree kept');
  await expect(closedCard(page).getByRole('button', { name: /Resume in worktree/ })).toHaveCount(0);
  await expectReopenFreshUnavailableWithItsReason(page);
});

test('a resume the daemon refuses shows the Resume failed strip and keeps the resume action', async ({ page, request }) => {
  const directory = mkdtempSync(join(tmpdir(), 'of-e2e-closed-'));
  try {
    const session = await fakeSessions.create(request, { name: 'Vanished directory', directory });
    await openSessionThatIsIdle(page, session);
    await exitFakeCli(request, session.id, { code: 0 });
    await expect(headerStateLabel(page)).toHaveText('closed');
    rmSync(directory, { recursive: true, force: true });

    await closedCard(page).getByRole('button', { name: /Resume in worktree/ }).click();

    await expect(lifecycleStrip(page)).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('lifecycle-title')).toContainText('Resume failed');
    await expect(page.getByTestId('lifecycle-message')).toContainText('directory no longer exists');
    await expect(page.getByTestId('session-closed-title')).toHaveText(/Not running/);
    await expect(closedCard(page)).toHaveAttribute('data-variant', 'error');
    await expect(closedCard(page).getByRole('button', { name: /Resume in worktree/ })).toBeEnabled();
    await expect(headerStateLabel(page)).toHaveText('closed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
