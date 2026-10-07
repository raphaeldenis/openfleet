import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitFakeCli, sessionStateLabel, signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();

const lifecycleStrip = (page: Page) => page.getByTestId('lifecycle-banner');
const closedCard = (page: Page) => page.getByTestId('session-closed-footer');

async function openSessionThatIsIdle(page: Page, session: { id: string; hooks: { announceIdle(): Promise<void> } }): Promise<void> {
  await signInAsAdmin(page);
  await session.hooks.announceIdle();
  await page.goto(`/session/${session.id}`);
  await expect(sessionStateLabel(page)).toHaveText('idle');
}

async function expectReopenFreshEnabled(page: Page): Promise<void> {
  await expect(closedCard(page).getByRole('button', { name: 'Reopen fresh' })).toBeEnabled();
}

test('an agent that exits with an error closes the session with the error strip, the exit code and both actions', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Crashed' });
  await openSessionThatIsIdle(page, session);

  await exitFakeCli(request, session.id, { code: 1 });

  await expect(sessionStateLabel(page)).toHaveText('closed · exit 1');
  await expect(page.getByTestId('session-details').getByTestId('state-chip')).toHaveAttribute('data-errblink', '1');
  await expect(page.getByTestId('session-exit-code')).toHaveText(/^exit 1 · \d{2}[:.]\d{2}$/);
  await expect(lifecycleStrip(page)).toHaveAttribute('data-variant', 'error');
  await expect(lifecycleStrip(page)).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('lifecycle-title')).toContainText('Agent process exited');
  await expect(page.getByTestId('lifecycle-message')).toHaveText('The agent process ended unexpectedly — reopen the session to resume the conversation.');
  await expect(page.getByTestId('lifecycle-copy-details')).toHaveText('Copy details');
  await expect(page.getByTestId('session-closed-title')).toContainText('Closed · exit 1');
  await expect(closedCard(page)).toHaveAttribute('data-variant', 'error');
  await expect(closedCard(page).getByRole('button', { name: /Resume in worktree/ })).toBeEnabled();
  await expectReopenFreshEnabled(page);
  await expect(page.getByTestId('composer-input')).toHaveCount(0);
});

test('Reopen fresh asks for confirmation, then starts the closed session again on a new conversation', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Start over' });
  await openSessionThatIsIdle(page, session);
  await exitFakeCli(request, session.id, { code: 0 });
  await expect(sessionStateLabel(page)).toHaveText('closed · exit 0');

  await closedCard(page).getByRole('button', { name: 'Reopen fresh' }).click();
  await expect(page.getByTestId('reopen-fresh-confirm-text')).toContainText('Start a new conversation? The previous one is not resumed.');
  await page.getByRole('button', { name: 'Start new conversation' }).click();

  await expect(sessionStateLabel(page)).not.toContainText('closed');
  await expect(closedCard(page)).toHaveCount(0);
});

test('a session that ends cleanly closes with a neutral card, no strip and the worktree note', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Finished' });
  await openSessionThatIsIdle(page, session);

  await exitFakeCli(request, session.id, { code: 0 });

  await expect(sessionStateLabel(page)).toHaveText('closed · exit 0');
  await expect(page.getByTestId('session-details').getByTestId('state-chip')).not.toHaveAttribute('data-errblink', '1');
  await expect(page.getByTestId('session-closed-title')).toContainText('Closed · exit 0');
  await expect(closedCard(page)).toContainText('Worktree kept · transcript is read-only.');
  await expect(closedCard(page)).toHaveAttribute('data-variant', 'neutral');
  await expect(lifecycleStrip(page)).toHaveCount(0);
  await expect(closedCard(page).getByRole('button', { name: /Resume in worktree/ })).toBeEnabled();
  await expectReopenFreshEnabled(page);
});

test('a closed session keeps showing its last state, read-only, in the State card', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Left a state' });
  const lastState = { sessionId: session.id, updatedAt: new Date().toISOString(), plan: ['Ship the card layout'], todo: [], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [] };
  await page.route(`**/api/sessions/${session.id}/working-state`, (route) => route.fulfill({ json: lastState }));
  await openSessionThatIsIdle(page, session);

  await exitFakeCli(request, session.id, { code: 0 });

  const stateCard = page.getByTestId('state-panel');
  await expect(stateCard.getByTestId('state-panel-updated')).toHaveText(/^last state · read-only · \d{2}[:.]\d{2}$/);
  await expect(stateCard.getByTestId('state-section-plan')).toContainText('Ship the card layout');
  await expect(stateCard).not.toContainText('State not shown');
});

test('a refused resume closes the session as conversation not found, explains it once and offers no resume', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Lost transcript' });
  await openSessionThatIsIdle(page, session);

  await exitFakeCli(request, session.id, { code: 1, conversationNotFound: true });

  await expect(sessionStateLabel(page)).toHaveText('closed · exit 1');
  await expect(lifecycleStrip(page)).toHaveAttribute('data-variant', 'error');
  await expect(page.getByTestId('lifecycle-title')).toContainText('Conversation not found');
  await expect(page.getByTestId('lifecycle-message')).toHaveText('The transcript for this session is gone; start a new session from its handoff.');
  await expect(page.getByTestId('lifecycle-copy-details')).toBeVisible();
  await expect(page.getByTestId('session-closed-title')).toHaveText(/Not running/);
  await expect(closedCard(page)).not.toContainText('Worktree kept');
  await expect(closedCard(page).getByRole('button', { name: /Resume in worktree/ })).toHaveCount(0);
  await expectReopenFreshEnabled(page);
});

test('a resume the daemon refuses shows the Resume failed strip and keeps the resume action', async ({ page, request }) => {
  const directory = mkdtempSync(join(tmpdir(), 'of-e2e-closed-'));
  try {
    const session = await fakeSessions.create(request, { name: 'Vanished directory', directory });
    await openSessionThatIsIdle(page, session);
    await exitFakeCli(request, session.id, { code: 0 });
    await expect(sessionStateLabel(page)).toHaveText('closed · exit 0');
    rmSync(directory, { recursive: true, force: true });

    await closedCard(page).getByRole('button', { name: /Resume in worktree/ }).click();

    await expect(lifecycleStrip(page)).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('lifecycle-title')).toContainText('Resume failed');
    await expect(page.getByTestId('lifecycle-message')).toContainText('directory no longer exists');
    await expect(page.getByTestId('session-closed-title')).toHaveText(/Not running/);
    await expect(closedCard(page)).toHaveAttribute('data-variant', 'error');
    await expect(closedCard(page).getByRole('button', { name: /Resume in worktree/ })).toBeEnabled();
    await expect(sessionStateLabel(page)).toHaveText('closed · exit 0');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
