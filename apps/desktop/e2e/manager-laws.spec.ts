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

async function enactLaw(request: APIRequestContext, managerId: string, text: string) {
  await request.post(`${api}/api/managers/${managerId}/fake-propose-law`, { headers: adminHeaders, data: { text, incident: `Incident for ${text}` } });
  const pending = await (await request.get(`${api}/api/governance/proposals`, { headers: adminHeaders })).json() as { id: string; payload: { text: string } }[];
  const proposal = pending.find((candidate) => candidate.payload.text === text)!;
  await request.post(`${api}/api/governance/proposals/${proposal.id}/decide`, { headers: adminHeaders, data: { decision: 'approve' } });
}

async function lawsOf(request: APIRequestContext, managerId: string) {
  const governance = await (await request.get(`${api}/api/managers/${managerId}/governance`, { headers: adminHeaders })).json() as { laws: { id: string; text: string; revision: number }[] };
  return governance.laws;
}

const openLaws = async (page: Page, managerId: string) => {
  await page.goto(`/manager/${managerId}`);
  return page.getByTestId('manager-governance-laws');
};

test('a human edits a law in place and the new text and revision show', async ({ page, request }) => {
  const manager = await createManager(request, 'Governor');
  await enactLaw(request, manager.id, 'Never deploy on Friday');
  const laws = await openLaws(page, manager.id);
  await expect(laws.getByText('Never deploy on Friday')).toBeVisible();

  await laws.getByRole('button', { name: 'Edit law: Never deploy on Friday' }).click();
  const field = laws.getByRole('textbox', { name: 'Law text' });
  await field.fill('Never deploy on Friday afternoon');
  await laws.getByRole('button', { name: 'Save law' }).click();

  await expect(laws.getByText('Never deploy on Friday afternoon')).toBeVisible();
  await expect(laws.getByText(/Revision 2/)).toBeVisible();
  await expect(field).toHaveCount(0);
});

test('a stale edit tells the law changed, keeps the draft and shows the current text', async ({ page, request }) => {
  const manager = await createManager(request, 'Governor');
  await enactLaw(request, manager.id, 'Never deploy on Friday');
  const laws = await openLaws(page, manager.id);
  await laws.getByRole('button', { name: 'Edit law: Never deploy on Friday' }).click();
  await laws.getByRole('textbox', { name: 'Law text' }).fill('My own wording');
  const [law] = await lawsOf(request, manager.id);
  await request.patch(`${api}/api/governance/laws/${law!.id}`, { headers: adminHeaders, data: { text: 'Changed elsewhere', expectedRevision: 1 } });

  await laws.getByRole('button', { name: 'Save law' }).click();

  await expect(laws.getByText('This law changed since you opened it. Reload it.')).toBeVisible();
  await expect(laws.getByRole('textbox', { name: 'Law text' })).toHaveValue('My own wording');
  await expect(laws.getByTestId('manager-law-current')).toContainText('Changed elsewhere');
});

test('a human withdraws a law after a confirmation and it moves to the withdrawn laws', async ({ page, request }) => {
  const manager = await createManager(request, 'Governor');
  await enactLaw(request, manager.id, 'Never deploy on Friday');
  const laws = await openLaws(page, manager.id);

  await laws.getByRole('button', { name: 'Withdraw law: Never deploy on Friday' }).click();
  await expect(laws.getByRole('button', { name: 'Confirm withdrawal' })).toBeVisible();
  expect(await lawsOf(request, manager.id)).toMatchObject([{ revision: 1 }]);
  await laws.getByRole('button', { name: 'Confirm withdrawal' }).click();

  await expect(page.getByTestId('manager-governance-withdrawn-laws').getByText('Never deploy on Friday')).toBeVisible();
  await expect(laws.getByText('Never deploy on Friday')).toHaveCount(0);
});

test('a law changed through the API shows without a reload', async ({ page, request }) => {
  const manager = await createManager(request, 'Governor');
  await enactLaw(request, manager.id, 'Never deploy on Friday');
  const laws = await openLaws(page, manager.id);
  await expect(laws.getByText('Never deploy on Friday')).toBeVisible();
  const [law] = await lawsOf(request, manager.id);

  await request.patch(`${api}/api/governance/laws/${law!.id}`, { headers: adminHeaders, data: { text: 'Reworded elsewhere', expectedRevision: 1 } });

  await expect(laws.getByText('Reworded elsewhere')).toBeVisible();
});
