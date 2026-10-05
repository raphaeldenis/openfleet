import { expect, test } from '@playwright/test';
import { adminHeaders, api, signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();

test('the sidebar hides closed sessions until "Show closed" is pressed, and keeps a closed manager in the Managers group', async ({ page, request }) => {
  const running = await fakeSessions.create(request, { name: 'Sidebar running' });
  const finished = await fakeSessions.create(request, { name: 'Sidebar finished' });
  const manager = await fakeSessions.create(request, { name: 'Sidebar manager', manager: { pulseSeconds: 3600, childrenCap: 2, mission: 'Keep the fleet tidy' } });
  await signInAsAdmin(page);
  await page.goto('/');
  await expect(page.getByTestId(`session-${finished.id}`)).toBeVisible();

  await request.post(`${api}/api/sessions/${finished.id}/close`, { headers: adminHeaders });
  await request.post(`${api}/api/sessions/${manager.id}/close`, { headers: adminHeaders });

  await expect(page.getByTestId(`session-${finished.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`session-${running.id}`)).toBeVisible();
  await expect(page.getByTestId(`session-${manager.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`manager-row-${manager.id}`)).toContainText('Sidebar manager');
  await expect(page.getByTestId(`manager-row-${manager.id}`).getByTestId('state-chip')).toHaveAttribute('data-state', 'closed');

  await page.getByRole('button', { name: /^Show closed/ }).click();

  await expect(page.getByTestId(`session-${finished.id}`)).toBeVisible();
  await expect(page.getByTestId(`session-${manager.id}`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Show closed/ })).toHaveAttribute('aria-pressed', 'true');
});

test('the sidebar stacks Sessions, Managers and Helm, shows "◎ —" for a closed manager, and keeps a collapsed group collapsed after a reload', async ({ page, request }) => {
  const session = await fakeSessions.create(request, { name: 'Group session' });
  const manager = await fakeSessions.create(request, { name: 'Group manager', manager: { pulseSeconds: 3600, childrenCap: 2, mission: 'Keep the fleet tidy' } });
  await request.post(`${api}/api/sessions/${manager.id}/close`, { headers: adminHeaders });
  await signInAsAdmin(page);
  await page.goto('/');
  const sidebar = page.getByTestId('app-nav');
  const groupToggle = (title: string) => sidebar.getByRole('button', { name: title, exact: true });

  const sessionsBox = await groupToggle('Sessions').boundingBox();
  const managersBox = await groupToggle('Managers').boundingBox();
  const helmBox = await groupToggle('Helm').boundingBox();
  expect(sessionsBox!.y).toBeLessThan(managersBox!.y);
  expect(managersBox!.y).toBeLessThan(helmBox!.y);
  await expect(page.getByTestId(`manager-row-${manager.id}-countdown`)).toHaveText('◎ —');

  await groupToggle('Managers').click();
  await expect(page.getByTestId(`manager-row-${manager.id}`)).toHaveCount(0);
  await page.reload();

  await expect(groupToggle('Managers')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId(`session-${session.id}`)).toBeVisible();
});
