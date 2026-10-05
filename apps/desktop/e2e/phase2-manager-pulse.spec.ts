import { expect, test } from '@playwright/test';
import { readE2eAdminToken } from '../../../scripts/e2e/e2eHome';

import { api } from './support/daemon';
const token = readE2eAdminToken();
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

let createdManagerId: string | undefined;

test.afterEach(async ({ request }) => {
  if (!createdManagerId) return;
  await request.post(`${api}/api/sessions/${createdManagerId}/close`, { headers });
  createdManagerId = undefined;
});

test('a manager card shows its children headroom, and pulsing a manager that has not started yet queues the first pulse silently and reports the second as coalesced', async ({ page, request }) => {
  await page.addInitScript(([t, a]) => { localStorage.setItem('openfleet.adminToken', t); localStorage.setItem('openfleet.apiUrl', a); }, [token, api]);
  await page.goto('/');

  const created = await request.post(`${api}/api/sessions`, {
    headers,
    data: { directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 3600, childrenCap: 2, mission: 'Ship phase 2' } },
  });
  const manager = await created.json();
  createdManagerId = manager.id;
  await expect(page.getByTestId(`manager-${manager.id}-children`)).toHaveText('0/2');

  // The session has not announced itself (no SessionStart yet), so the first pulse waits in its queue and
  // the second is reported as coalesced into it.
  const pulseButton = page.getByTestId(`manager-${manager.id}-pulse`);
  const pulseMessage = page.getByTestId(`manager-${manager.id}-pulse-message`);
  const isPulseResponse = (response: { url(): string }) => response.url().endsWith(`/api/managers/${manager.id}/pulse`);

  await Promise.all([page.waitForResponse(isPulseResponse), pulseButton.click()]);
  await expect(pulseMessage).toHaveCount(0);

  await Promise.all([page.waitForResponse(isPulseResponse), pulseButton.click()]);
  await expect(pulseMessage).toHaveText('Pulse coalesced — already queued');
});
