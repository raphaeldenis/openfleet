import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminHeaders, api, signInAsAdmin } from './support/daemon';

const POLICY_STATUS = 'policy-save-status';
const LONGEST_RULE_ID = 'no-generic-send-message-to-fleet-session';

const sessionIdsToClose: string[] = [];

test.afterEach(async ({ request }) => {
  await request.put(`${api}/api/command-policy`, { headers: adminHeaders, data: { version: 1 } });
  for (const id of sessionIdsToClose.splice(0)) await request.post(`${api}/api/sessions/${id}/close`, { headers: adminHeaders });
});

async function openCommandPolicy(page: Page): Promise<void> {
  await signInAsAdmin(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Command policy', exact: true }).click();
  await expect(page.getByRole('tabpanel').getByRole('heading', { level: 1, name: 'Command policy' })).toBeVisible();
}

async function createChildSession(request: APIRequestContext): Promise<{ id: string; hookToken: string }> {
  const created = async (data: Record<string, unknown>) => ((await (await request.post(`${api}/api/sessions`, { headers: adminHeaders, data: { directory: '/tmp', emoji: '🧪', harness: 'fake', ...data } })).json()) as { id: string }).id;
  const parentId = await created({ name: 'Policy boss' });
  const childId = await created({ name: 'Policy worker', parentId, role: 'DEV' });
  sessionIdsToClose.push(childId, parentId);
  const { hookToken } = await (await request.get(`${api}/api/sessions/${childId}/tokens`, { headers: adminHeaders })).json();
  return { id: childId, hookToken };
}

const hookAnswerOf = async (request: APIRequestContext, hookToken: string, command: string) =>
  (await (await request.post(`${api}/hooks/${hookToken}`, { data: { session_id: 'x', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } })).json()) as { hookSpecificOutput?: { permissionDecision?: string } };

const modeRadio = (page: Page, name: 'Enforce' | 'Observe' | 'Off') => page.getByRole('radiogroup', { name: 'Command policy mode' }).getByRole('radio', { name, exact: true });
const askSwitch = (page: Page) => page.getByRole('switch', { name: 'Refuse permission dialogs nobody can answer' });

test('the screen names every control: the mode, the ask switch, the rules, the try-out and the refusals', async ({ page }) => {
  await openCommandPolicy(page);

  await expect(modeRadio(page, 'Observe')).toBeChecked();
  await expect(modeRadio(page, 'Enforce')).not.toBeChecked();
  await expect(modeRadio(page, 'Off')).not.toBeChecked();
  await expect(askSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('policy-ask-consequence')).toContainText('immediate refusal');
  await expect(page.getByRole('table', { name: 'Command policy rules' })).toBeVisible();
  const rmRule = page.getByTestId('policy-rule-no-forced-recursive-rm');
  await expect(rmRule).toContainText('deny');
  await expect(rmRule).toContainText('rm -r <path>');
  await expect(page.getByRole('button', { name: 'Disable rule no-forced-recursive-rm' })).toBeVisible();
  await expect(page.getByLabel('Command to try')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try it' })).toBeDisabled();
  await expect(page.getByRole('list', { name: 'Recent refusals' }).or(page.getByTestId('policy-denials-empty'))).toBeVisible();
  await expect(page.getByTestId('policy-degraded')).toContainText('healthy');
});

for (const viewport of [{ width: 1200, height: 800 }, { width: 1440, height: 900 }]) {
  test(`a rule identifier stays on one line in the Rule column at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openCommandPolicy(page);

    const ruleId = page.getByTestId(`policy-rule-${LONGEST_RULE_ID}`).locator('.rule-id');
    await expect(ruleId).toBeVisible();

    const { height, lineHeight } = await ruleId.evaluate((element) => ({ height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight) }));
    expect(height).toBeLessThan(lineHeight * 1.5);
  });
}

test('choosing a mode saves at once and the very next hook of a child answers differently, with no restart', async ({ page, request }) => {
  const child = await createChildSession(request);
  await openCommandPolicy(page);

  await modeRadio(page, 'Enforce').check();
  await expect(page.getByTestId(POLICY_STATUS)).toContainText('Saved: mode enforce');
  const whileEnforcing = await hookAnswerOf(request, child.hookToken, 'rm -rf build');
  await modeRadio(page, 'Off').check();
  await expect(page.getByTestId(POLICY_STATUS)).toContainText('Saved: mode off');
  const whileOff = await hookAnswerOf(request, child.hookToken, 'rm -rf build');

  expect(whileEnforcing.hookSpecificOutput?.permissionDecision).toBe('deny');
  expect(whileOff).toEqual({});
  await expect(page.getByTestId('policy-mode-consequence')).toContainText('Permission dialogs of unattended sessions are still refused');
  await expect(askSwitch(page)).toHaveAttribute('aria-checked', 'true');
});

test('the mode radios answer to the arrow keys', async ({ page }) => {
  await openCommandPolicy(page);

  await modeRadio(page, 'Observe').focus();
  await page.keyboard.press('ArrowLeft');

  await expect(modeRadio(page, 'Enforce')).toBeChecked();
  await expect(page.getByTestId(POLICY_STATUS)).toContainText('Saved: mode enforce');
});

test('quick arrow presses end on the focused mode, on the screen and in the daemon', async ({ page, request }) => {
  await openCommandPolicy(page);

  await modeRadio(page, 'Observe').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');

  await expect(modeRadio(page, 'Off')).toBeChecked();
  await expect(modeRadio(page, 'Off')).toBeFocused();
  await expect(async () => {
    expect(((await (await request.get(`${api}/api/command-policy`, { headers: adminHeaders })).json()) as { mode: string }).mode).toBe('off');
  }).toPass({ timeout: 10_000 });
});

test('a save does not move the rest of the screen', async ({ page }) => {
  await openCommandPolicy(page);
  const healthBanner = page.getByTestId('policy-degraded');
  const topBefore = (await healthBanner.boundingBox())?.y;

  await modeRadio(page, 'Enforce').check();
  await expect(page.getByTestId(POLICY_STATUS)).toContainText('Saved: mode enforce');

  expect((await healthBanner.boundingBox())?.y).toBe(topBefore);
});

test('the ask switch states what turning it off means and gives the dialogs back', async ({ page }) => {
  await openCommandPolicy(page);

  await askSwitch(page).click();

  await expect(askSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(askSwitch(page)).toHaveText('Off');
  await expect(page.getByTestId('policy-ask-consequence')).toContainText('back to the approval flow');
  await expect(page.getByTestId('policy-ask-consequence')).toContainText('30 seconds');
  await askSwitch(page).press('Space');
  await expect(askSwitch(page)).toHaveAttribute('aria-checked', 'true');
});

test('a rule disabled from the list stops refusing, and can be enabled again', async ({ page, request }) => {
  const child = await createChildSession(request);
  await openCommandPolicy(page);
  await modeRadio(page, 'Enforce').check();
  await expect(page.getByTestId(POLICY_STATUS)).toContainText('Saved');

  await page.getByRole('button', { name: 'Disable rule no-forced-recursive-rm' }).click();

  await expect(page.getByTestId('policy-rule-no-forced-recursive-rm')).toContainText('Disabled');
  expect(await hookAnswerOf(request, child.hookToken, 'rm -rf build')).toEqual({});
  await page.getByRole('button', { name: 'Enable rule no-forced-recursive-rm' }).click();
  await expect(page.getByTestId('policy-rule-no-forced-recursive-rm')).toContainText('Enabled');
  expect((await hookAnswerOf(request, child.hookToken, 'rm -rf build')).hookSpecificOutput?.permissionDecision).toBe('deny');
});

test('trying a command shows the verdict, the rule and the alternative, and runs and journals nothing', async ({ page, request }) => {
  await openCommandPolicy(page);
  await modeRadio(page, 'Enforce').check();
  await expect(page.getByTestId(POLICY_STATUS)).toContainText('Saved');
  const journalBefore = await (await request.get(`${api}/api/command-policy/denials`, { headers: adminHeaders })).json();

  await page.getByLabel('Command to try').fill('rm -rf build');
  await page.getByLabel('Role (optional)').fill('DEV');
  await page.getByRole('button', { name: 'Try it' }).click();

  const result = page.getByTestId('policy-try-result');
  await expect(result).toContainText('Refused by no-forced-recursive-rm');
  await expect(result).toContainText('Alternative: Use `rm -r <path>`');
  await expect(result).toContainText('dev profile');
  await page.getByLabel('Command to try').fill('git status');
  await page.getByLabel('Command to try').press('Enter');
  await expect(result).toContainText('Allowed: no rule refuses it');
  expect(await (await request.get(`${api}/api/command-policy/denials`, { headers: adminHeaders })).json()).toEqual(journalBefore);
});

test('a command only observed says so instead of claiming a refusal', async ({ page }) => {
  await openCommandPolicy(page);

  await page.getByLabel('Command to try').fill('rm -rf build');
  await page.getByRole('button', { name: 'Try it' }).click();

  await expect(page.getByTestId('policy-try-result')).toContainText('would refuse it, but the policy only observes');
});

test('the recent refusals list the refusal of a child with its rule, its excerpt and its alternative', async ({ page, request }) => {
  const child = await createChildSession(request);
  await openCommandPolicy(page);
  await modeRadio(page, 'Enforce').check();
  await expect(page.getByTestId(POLICY_STATUS)).toContainText('Saved');

  await hookAnswerOf(request, child.hookToken, 'rm -rf build-e2e-marker');
  await expect(async () => {
    await page.getByTestId('policy-denials-refresh').click();
    await expect(page.getByTestId('policy-denial').filter({ hasText: 'rm -rf build-e2e-marker' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });

  const denial = page.getByTestId('policy-denial').filter({ hasText: 'rm -rf build-e2e-marker' }).first();
  await expect(denial).toContainText('Refused');
  await expect(denial).toContainText('no-forced-recursive-rm');
  await expect(denial).toContainText('Alternative: Use `rm -r <path>`');
});

test('a failed save keeps the previous mode on screen and says nothing changed', async ({ page }) => {
  await openCommandPolicy(page);
  await page.route(`${api}/api/command-policy`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    return route.fulfill({ status: 409, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ error: 'config_read_only', kind: 'conflict', retry: 'never', message: 'the command policy file is read-only.' }) });
  });

  await modeRadio(page, 'Enforce').click();

  await expect(page.getByTestId('policy-save-error')).toContainText('command-policy.json is read-only. Nothing was changed.');
  await expect(modeRadio(page, 'Observe')).toBeChecked();
});
