import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const api = 'http://127.0.0.1:7332';
const token = readFileSync('/tmp/of-e2e/admin.token', 'utf8').trim();
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

test('a fake session appears in the sidebar, shows output, and its permission gate is decided from the inbox', async ({ page, request }) => {
  await page.addInitScript(([t, a]) => { localStorage.setItem('openfleet.adminToken', t); localStorage.setItem('openfleet.apiUrl', a); }, [token, api]);
  await page.goto('/');

  const created = await request.post(`${api}/api/sessions`, { headers, data: { directory: '/tmp', name: 'Gimli', emoji: '⚔️', harness: 'fake' } });
  const session = await created.json();
  await expect(page.getByTestId(`session-${session.id}`)).toContainText('⚔️ Gimli');

  const hookToken = (await (await request.get(`${api}/api/sessions/${session.id}/tokens`, { headers })).json()).hookToken;
  await request.post(`${api}/hooks/${hookToken}`, { data: { session_id: 'x', hook_event_name: 'SessionStart' } });
  await expect(page.getByTestId(`session-${session.id}-state`)).toHaveText('idle');

  await page.getByTestId(`session-${session.id}`).click();
  await request.post(`${api}/api/sessions/${session.id}/fake-output`, { headers, data: { data: 'hello from pty' } });
  await expect(page.getByTestId('terminal')).toContainText('hello from pty');

  const gate = request.post(`${api}/hooks/${hookToken}`, { data: { session_id: 'x', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } } });
  await expect(page.getByTestId('inbox-item')).toContainText('rm -rf dist');
  await page.getByTestId('inbox-allow').click();
  expect((await (await gate).json()).hookSpecificOutput.decision.behavior).toBe('allow');
  await expect(page.getByTestId(`session-${session.id}-state`)).toHaveText('generating');
});
