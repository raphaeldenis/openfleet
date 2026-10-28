import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminHeaders, api, fulfillWithJson, interceptDaemonPost, signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();

const GOAL_TEXT = 'Ship the handoff acceptance suite';
const uniqueName = (prefix: string) => `${prefix} ${randomUUID().slice(0, 8)}`;

let docsFolder: string;
const handoffsFolder = () => join(docsFolder, 'handoffs');
const handoffFiles = () => (existsSync(handoffsFolder()) ? readdirSync(handoffsFolder()) : []);

async function createProjectWithDocsFolder(request: APIRequestContext): Promise<{ id: string; name: string }> {
  const name = uniqueName('Handoff project');
  const created = await request.post(`${api}/api/projects`, { headers: adminHeaders, data: { name, docsFolderPath: docsFolder } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  return { id, name };
}

test.beforeEach(async ({ page }) => {
  docsFolder = realpathSync(mkdtempSync(join(tmpdir(), 'of-e2e-handoff-')));
  await signInAsAdmin(page);
});

test.afterEach(() => {
  rmSync(docsFolder, { recursive: true, force: true });
});

test('saving the handoff of a session in a project writes the file with the edited goal and says where', async ({ page, request }) => {
  const project = await createProjectWithDocsFolder(request);
  const session = await fakeSessions.create(request, { name: uniqueName('Handoff save'), projectId: project.id });
  await session.hooks.announceIdle();
  await page.goto(`/session/${session.id}`);
  await page.getByRole('button', { name: 'Write handoff' }).click();
  const panel = page.getByRole('dialog', { name: 'Handoff preview' });
  await panel.getByRole('textbox', { name: 'Goal', exact: true }).fill(GOAL_TEXT);

  await panel.getByRole('button', { name: 'Save handoff' }).click();

  await expect(panel.getByRole('status')).toContainText('Saved to handoffs/');
  await expect(panel.getByRole('button', { name: 'Saved · open in Notes › handoffs' })).toBeVisible();
  await expect.poll(handoffFiles).toHaveLength(1);
  expect(readFileSync(join(handoffsFolder(), handoffFiles()[0]!), 'utf8')).toContain(GOAL_TEXT);
});

test('closing a session with the handoff box checked writes the handoff and closes the session', async ({ page, request }) => {
  const project = await createProjectWithDocsFolder(request);
  const session = await fakeSessions.create(request, { name: uniqueName('Handoff close'), projectId: project.id });
  await session.hooks.announceIdle();
  await page.goto(`/session/${session.id}`);
  await page.getByTestId('session-close').click();
  const dialog = page.getByRole('dialog');
  const box = dialog.getByRole('checkbox', { name: 'Write a handoff when this session closes' });
  await expect(box).toBeEnabled();
  await expect(box).toBeChecked();
  await expect(dialog.getByTestId('close-handoff-hint')).toContainText('handoffs/');

  await dialog.getByTestId('close-confirm-submit').click();

  await expect.poll(handoffFiles).toHaveLength(1);
  await expect.poll(async () => (await (await request.get(`${api}/api/sessions/${session.id}`, { headers: adminHeaders })).json()).state).toBe('closed');
});

test('closing a session with the handoff box unchecked writes nothing', async ({ page, request }) => {
  const project = await createProjectWithDocsFolder(request);
  const session = await fakeSessions.create(request, { name: uniqueName('Handoff close no box'), projectId: project.id });
  await session.hooks.announceIdle();
  await page.goto(`/session/${session.id}`);
  await page.getByTestId('session-close').click();
  const dialog = page.getByRole('dialog');
  const box = dialog.getByRole('checkbox', { name: 'Write a handoff when this session closes' });
  await expect(box).toBeEnabled();

  await box.uncheck();
  await dialog.getByTestId('close-confirm-submit').click();

  await expect.poll(async () => (await (await request.get(`${api}/api/sessions/${session.id}`, { headers: adminHeaders })).json()).state).toBe('closed');
  expect(handoffFiles()).toEqual([]);
});

test('New session offers the saved handoffs of the project, shows the picked one as a chip and sends it with the project', async ({ page, request }) => {
  const project = await createProjectWithDocsFolder(request);
  const source = await fakeSessions.create(request, { name: uniqueName('Handoff source'), projectId: project.id });
  const saved = await request.post(`${api}/api/sessions/${source.id}/handoff`, {
    headers: adminHeaders,
    data: { goal: GOAL_TEXT, state: 'Idle', decisions: 'None', filesTouched: 'None', nextSteps: 'Start from it', openQuestions: 'None' },
  });
  expect(saved.status()).toBe(201);
  const handoffFile = (await saved.json()).relativePath.split('/').pop() as string;
  let createRequestBody: Record<string, unknown> | undefined;
  await interceptDaemonPost(page, '/api/sessions', async (route) => {
    createRequestBody = route.request().postDataJSON();
    await fulfillWithJson(route, 400, { error: 'invalid_body', message: 'stopped by the test', kind: 'invalid', retry: 'never' });
  });
  await page.goto('/new');
  const picker = page.getByRole('combobox', { name: 'Start from a handoff' });
  await expect(picker).toBeDisabled();

  await page.getByTestId('new-session-project').selectOption({ label: project.name });
  await picker.click();
  await page.getByRole('option', { name: handoffFile }).click();

  await expect(page.getByText(`@file handoffs/${handoffFile}`)).toBeVisible();
  await page.getByTestId('new-session-directory').fill('/tmp');
  await page.getByTestId('new-session-name').fill(uniqueName('Started from handoff'));
  await page.getByTestId('new-session-submit').click();
  await expect.poll(() => createRequestBody).toMatchObject({ projectId: project.id, handoffFile });
});

test('removing the picked handoff takes the chip away and sends no handoff file', async ({ page, request }) => {
  const project = await createProjectWithDocsFolder(request);
  const source = await fakeSessions.create(request, { name: uniqueName('Handoff remove'), projectId: project.id });
  const saved = await request.post(`${api}/api/sessions/${source.id}/handoff`, {
    headers: adminHeaders,
    data: { goal: GOAL_TEXT, state: 'Idle', decisions: 'None', filesTouched: 'None', nextSteps: 'None', openQuestions: 'None' },
  });
  const handoffFile = (await saved.json()).relativePath.split('/').pop() as string;
  let createRequestBody: Record<string, unknown> | undefined;
  await interceptDaemonPost(page, '/api/sessions', async (route) => {
    createRequestBody = route.request().postDataJSON();
    await fulfillWithJson(route, 400, { error: 'invalid_body', message: 'stopped by the test', kind: 'invalid', retry: 'never' });
  });
  await page.goto('/new');
  await page.getByTestId('new-session-project').selectOption({ label: project.name });
  await page.getByRole('combobox', { name: 'Start from a handoff' }).click();
  await page.getByRole('option', { name: handoffFile }).click();
  await expect(page.getByText(`@file handoffs/${handoffFile}`)).toBeVisible();

  await page.getByRole('button', { name: `Remove handoff ${handoffFile}` }).click();

  await expect(page.getByText(`@file handoffs/${handoffFile}`)).toHaveCount(0);
  await page.getByTestId('new-session-directory').fill('/tmp');
  await page.getByTestId('new-session-name').fill(uniqueName('Started without handoff'));
  await page.getByTestId('new-session-submit').click();
  await expect.poll(() => createRequestBody).toMatchObject({ projectId: project.id });
  expect(createRequestBody).not.toHaveProperty('handoffFile');
});
