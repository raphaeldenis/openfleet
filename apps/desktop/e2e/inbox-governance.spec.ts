import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { api, adminHeaders, signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();
const ANY_PULSE_SECONDS = 3600;

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

async function createManager(request: APIRequestContext, name: string) {
  return fakeSessions.create(request, { name, emoji: '🧭', manager: { pulseSeconds: ANY_PULSE_SECONDS, childrenCap: 1, mission: 'Govern' } });
}

async function proposeLaw(request: APIRequestContext, managerId: string, text: string) {
  await request.post(`${api}/api/managers/${managerId}/fake-propose-law`, { headers: adminHeaders, data: { text, incident: `Incident for ${text}` } });
}

test('a pending proposal shows in the Inbox, counts, and leaves with the count when approved', async ({ page, request }) => {
  const manager = await createManager(request, 'Governor');
  await page.goto('/inbox');
  await expect(page.getByTestId('inbox-count')).toHaveCount(0);

  await proposeLaw(request, manager.id, 'Never deploy on Friday');

  const card = page.getByTestId('governance-card').filter({ hasText: 'Never deploy on Friday' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Incident for Never deploy on Friday');
  await expect(page.getByTestId('inbox-count')).toHaveText('1');

  await card.getByRole('button', { name: 'Approve law proposal from Governor: Never deploy on Friday' }).click();

  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('inbox-count')).toHaveCount(0);
  await expect(page.getByText(/Copy this into/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /add to (the )?note/i })).toHaveCount(0);
});

test('surplus proposals wait, show on the Inbox chip and the manager page, and are released in order as places free up', async ({ page, request }) => {
  const PENDING_PLACES = 10;
  const manager = await createManager(request, 'Governor');
  try {
    await expectSurplusToWaitThenBeReleased({ page, request, managerId: manager.id, pendingPlaces: PENDING_PLACES });
  } finally {
    await decideEveryProposalOf(request, manager.id);
  }
});

async function decideEveryProposalOf(request: APIRequestContext, managerId: string) {
  const readGovernance = async () => (await request.get(`${api}/api/managers/${managerId}/governance`, { headers: adminHeaders })).json();
  for (let view = await readGovernance(); view.pending.length > 0; view = await readGovernance()) {
    for (const { id } of view.pending) await request.post(`${api}/api/governance/proposals/${id}/decide`, { headers: adminHeaders, data: { decision: 'approve' } });
  }
}

async function expectSurplusToWaitThenBeReleased({ page, request, managerId, pendingPlaces }: { page: Page; request: APIRequestContext; managerId: string; pendingPlaces: number }) {
  await page.goto('/inbox');
  for (let number = 1; number <= pendingPlaces + 2; number++) await proposeLaw(request, managerId, `Law number ${number}`);

  const governanceChip = page.getByTestId('inbox-filter-governance');
  await expect(governanceChip).toHaveText('Governance 10 · 2 waiting');
  await expect(page.getByTestId('governance-card').filter({ hasText: 'Law number 11' })).toHaveCount(0);

  await page.goto(`/manager/${managerId}`);
  const waiting = page.getByTestId('manager-governance-waiting');
  await expect(waiting.getByRole('heading', { name: 'Waiting (2)' })).toBeVisible();
  await expect(waiting.getByRole('listitem').first()).toContainText('Law number 11');
  await expect(waiting.getByRole('button')).toHaveCount(0);

  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Approve law proposal from Governor: Law number 1', exact: true }).click();

  await expect(page.getByTestId('governance-card').filter({ hasText: 'Law number 11' })).toBeVisible();
  await expect(governanceChip).toHaveText('Governance 10 · 1 waiting');
}

test('a denial needs a reason: the button stays inactive until one is typed, then the card goes', async ({ page, request }) => {
  const manager = await createManager(request, 'Governor');
  await page.goto('/inbox');
  await proposeLaw(request, manager.id, 'Deploy any time');
  const card = page.getByTestId('governance-card').filter({ hasText: 'Deploy any time' });
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Deny law proposal from Governor: Deploy any time' }).click();

  const confirm = card.getByRole('button', { name: 'Confirm denial' });
  await expect(confirm).toBeDisabled();
  await card.getByRole('textbox', { name: 'Reason for denying' }).fill('Too risky');
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('inbox-count')).toHaveCount(0);
});
