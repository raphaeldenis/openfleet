import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const api = 'http://127.0.0.1:7332';
const token = readFileSync('/tmp/of-e2e/admin.token', 'utf8').trim();
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

test('a manager card shows its children headroom, and pulsing a manager that cannot take the message yet queues the pulse once', async ({ page, request }) => {
  await page.addInitScript(([t, a]) => { localStorage.setItem('openfleet.adminToken', t); localStorage.setItem('openfleet.apiUrl', a); }, [token, api]);
  await page.goto('/');

  const created = await request.post(`${api}/api/sessions`, {
    headers,
    data: { directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 3600, childrenCap: 2, mission: 'Ship phase 2' } },
  });
  const manager = await created.json();
  await expect(page.getByTestId(`manager-${manager.id}-children`)).toHaveText('0/2');

  // The session has not announced itself (no SessionStart yet), so the first pulse waits in its queue and
  // every further pulse is reported as coalesced into it. The retry covers a second click landing before
  // the first request has finished and re-enabled the button.
  const pulseButton = page.getByTestId(`manager-${manager.id}-pulse`);
  const pulseMessage = page.getByTestId(`manager-${manager.id}-pulse-message`);
  await expect(async () => {
    await pulseButton.click();
    await expect(pulseMessage).toHaveText('Pulse coalesced — already queued', { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
});
