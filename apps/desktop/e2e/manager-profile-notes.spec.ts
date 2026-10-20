import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminHeaders, api, signInAsAdmin, useFakeSessions, type FakeSession } from './support/daemon';

const fakeSessions = useFakeSessions();

const STALE_PROFILE_TEXT = 'This profile changed since you opened it. Reload it.';

const aManager = (request: APIRequestContext): Promise<FakeSession> =>
  fakeSessions.create(request, { name: 'Lead', manager: { pulseSeconds: 3600, childrenCap: 2, mission: 'Ship the profile card' } });

const managerWritesItsProfile = (request: APIRequestContext, managerId: string, profile: { expertise?: string; pulseActions?: string[] }) =>
  request.patch(`${api}/api/managers/${managerId}`, { headers: adminHeaders, data: profile });

const expertiseField = (page: Page) => page.getByRole('textbox', { name: 'Expertise' });

const openProfileOf = async (page: Page, managerId: string) => {
  await page.goto(`/manager/${managerId}`);
  await expect(expertiseField(page)).toBeVisible();
};

test('the user writes the expertise and the pulse actions, saves them, and finds them after a reload', async ({ page, request }) => {
  await signInAsAdmin(page);
  const manager = await aManager(request);
  await openProfileOf(page, manager.id);

  await expertiseField(page).fill('Release trains');
  await page.getByRole('button', { name: 'Add pulse action' }).click();
  await page.getByRole('textbox', { name: 'Pulse action 1' }).fill('Check CI');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('manager-changes-count')).toHaveText('No changes');

  await page.reload();
  await expect(expertiseField(page)).toHaveValue('Release trains');
  await expect(page.getByRole('textbox', { name: 'Pulse action 1' })).toHaveValue('Check CI');
});

test('the form follows the manager when it edits its own profile, and keeps the draft the user is typing', async ({ page, request }) => {
  await signInAsAdmin(page);
  const manager = await aManager(request);
  await openProfileOf(page, manager.id);

  await managerWritesItsProfile(request, manager.id, { expertise: 'Written by the manager' });
  await expect(expertiseField(page)).toHaveValue('Written by the manager');

  await expertiseField(page).fill('Typed by the user');
  await managerWritesItsProfile(request, manager.id, { expertise: 'Written again by the manager' });
  await expect(page.getByText(STALE_PROFILE_TEXT)).toBeVisible();
  await expect(expertiseField(page)).toHaveValue('Typed by the user');
});

test('the user whose save is refused as stale reloads the profile, keeps the draft, and saves it', async ({ page, request }) => {
  await signInAsAdmin(page);
  const manager = await aManager(request);
  await openProfileOf(page, manager.id);
  await expertiseField(page).fill('Typed by the user');
  await managerWritesItsProfile(request, manager.id, { expertise: 'Written by the manager' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(STALE_PROFILE_TEXT)).toBeVisible();

  await page.getByRole('button', { name: 'Reload profile' }).click();
  await expect(page.getByText(STALE_PROFILE_TEXT)).toHaveCount(0);
  await expect(expertiseField(page)).toHaveValue('Typed by the user');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('manager-changes-count')).toHaveText('No changes');

  await page.reload();
  await expect(expertiseField(page)).toHaveValue('Typed by the user');
});

for (const theme of ['light', 'dark'] as const) {
  test(`design QA: the expertise and the pulse actions form in the ${theme} theme at 1280x1200`, async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 1200 });
    await signInAsAdmin(page, { theme });
    const manager = await aManager(request);
    await managerWritesItsProfile(request, manager.id, { expertise: 'Release trains and incident follow-up', pulseActions: ['Check CI on every open pull request', 'Unblock reviews older than a day'] });
    await openProfileOf(page, manager.id);
    await expect(page.getByRole('textbox', { name: 'Pulse action 2' })).toBeVisible();
    await page.screenshot({ path: `../../manager-profile-notes-${theme}-1280x1200.png`, fullPage: true });

    await expertiseField(page).fill('Typed by the user');
    await managerWritesItsProfile(request, manager.id, { expertise: 'Written by the manager' });
    await expect(page.getByText(STALE_PROFILE_TEXT)).toBeVisible();
    await page.getByRole('button', { name: 'Add pulse action' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Write the action or remove it')).toBeVisible();
    await page.screenshot({ path: `../../manager-profile-notes-conflict-${theme}-1280x1200.png`, fullPage: true });
  });
}
