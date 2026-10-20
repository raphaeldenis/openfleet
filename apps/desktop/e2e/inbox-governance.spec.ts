import { expect, test, type APIRequestContext } from '@playwright/test';
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
