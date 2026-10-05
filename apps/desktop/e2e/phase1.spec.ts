import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { e2eConfigPath, readE2eAdminToken } from '../../../scripts/e2e/e2eHome';

import { api } from './support/daemon';
const token = readE2eAdminToken();
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

const configPath = e2eConfigPath();

test('a model picked in Settings is written to config.json and served by the running daemon', async ({ page, request }) => {
  await page.addInitScript(([t, a]) => { localStorage.setItem('openfleet.adminToken', t); localStorage.setItem('openfleet.apiUrl', a); }, [token, api]);
  const configBefore = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const modelsBefore = await (await request.get(`${api}/api/models`, { headers })).json();
  const { models: availableModels } = await (await request.get(`${api}/api/models/available`, { headers })).json();
  const differentKnownModel: string = availableModels.find((modelId: string) => modelId !== modelsBefore.opus);
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();

    await page.getByRole('tab', { name: 'Models' }).click();
    await page.getByTestId('model-trigger-opus').click();
    await page.getByRole('option', { name: differentKnownModel, exact: true }).click();

    await expect(page.getByTestId('models-save-status')).toHaveText(/^✓ Saved opus\.$/);
    expect((await (await request.get(`${api}/api/models`, { headers })).json()).opus).toBe(differentKnownModel);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).models.opus).toBe(differentKnownModel);
  } finally {
    const restore = await request.put(`${api}/api/models`, { headers, data: { opus: modelsBefore.opus } });
    expect(restore.ok()).toBe(true);
    if (configBefore === undefined) rmSync(configPath, { force: true });
    else writeFileSync(configPath, configBefore);
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
