import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const api = 'http://127.0.0.1:7332';
const token = readFileSync('/tmp/of-e2e/admin.token', 'utf8').trim();
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

test('a model picked in Settings is written to config.json and served by the running daemon', async ({ page, request }) => {
  await page.addInitScript(([t, a]) => { localStorage.setItem('openfleet.adminToken', t); localStorage.setItem('openfleet.apiUrl', a); }, [token, api]);
  const modelsBefore = await (await request.get(`${api}/api/models`, { headers })).json();
  try {
    await page.goto('/');
    await page.getByTestId('nav-settings').click();

    await page.getByTestId('model-select-opus').selectOption('claude-fable-5');

    await expect(page.getByTestId('models-save-status')).toContainText(/saved/i);
    expect((await (await request.get(`${api}/api/models`, { headers })).json()).opus).toBe('claude-fable-5');
    expect(JSON.parse(readFileSync('/tmp/of-e2e/config.json', 'utf8')).models.opus).toBe('claude-fable-5');
  } finally {
    await request.put(`${api}/api/models`, { headers, data: { opus: modelsBefore.opus } });
  }
});

test('a fake session appears in the sidebar, shows output, and its permission gate is decided from the session view', async ({ page, request }) => {
  await page.addInitScript(([t, a]) => { localStorage.setItem('openfleet.adminToken', t); localStorage.setItem('openfleet.apiUrl', a); }, [token, api]);
  await page.goto('/');

  const created = await request.post(`${api}/api/sessions`, { headers, data: { directory: '/tmp', name: 'Gimli', emoji: '⚔️', harness: 'fake' } });
  const session = await created.json();
  const sessionRow = page.getByTestId(`session-${session.id}`);
  await expect(sessionRow).toContainText('⚔️ Gimli');

  const hookToken = (await (await request.get(`${api}/api/sessions/${session.id}/tokens`, { headers })).json()).hookToken;
  await request.post(`${api}/hooks/${hookToken}`, { data: { session_id: 'x', hook_event_name: 'SessionStart' } });
  await expect(sessionRow.getByTestId('state-chip-label')).toHaveText('idle');

  await sessionRow.click();
  await request.post(`${api}/api/sessions/${session.id}/fake-output`, { headers, data: { data: 'hello from pty' } });
  await expect(page.getByTestId('terminal')).toContainText('hello from pty');

  const gate = request.post(`${api}/hooks/${hookToken}`, { data: { session_id: 'x', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } } });
  await expect(page.getByTestId('permission-gate-card')).toContainText('rm -rf dist');
  await page.getByTestId('gate-approve').click();
  expect((await (await gate).json()).hookSpecificOutput.decision.behavior).toBe('allow');
  await expect(sessionRow.getByTestId('state-chip-label')).toHaveText('generating');

  const secondGate = request.post(`${api}/hooks/${hookToken}`, { data: { session_id: 'x', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } } });
  await page.getByTestId('nav-inbox').click();
  await expect(page.getByTestId('inbox-gate-card')).toContainText('rm -rf build');
  await page.getByTestId('inbox-allow').click();
  expect((await (await secondGate).json()).hookSpecificOutput.decision.behavior).toBe('allow');
  await expect(sessionRow.getByTestId('state-chip-label')).toHaveText('generating');
});
