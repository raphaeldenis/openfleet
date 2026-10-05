import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminHeaders, api, signInAsAdmin } from './support/daemon';

const uniqueName = (prefix: string) => `${prefix} ${randomUUID().slice(0, 8)}`;

test('Project home shows the project, its docs folder and its sessions, and starts a session already in that project', async ({ page, request }) => {
  const docsFolder = realpathSync(mkdtempSync(join(tmpdir(), 'of-e2e-home-docs-')));
  const projectName = uniqueName('Home project');
  const sessionName = uniqueName('Home session');
  const created = await request.post(`${api}/api/projects`, { headers: adminHeaders, data: { name: projectName, docsFolderPath: docsFolder } });
  const project = await created.json();
  const session = await (await request.post(`${api}/api/sessions`, { headers: adminHeaders, data: { directory: '/tmp', name: sessionName, emoji: '🧪', harness: 'fake', projectId: project.id } })).json();
  try {
    await signInAsAdmin(page);

    await page.goto(`/project/${project.id}`);

    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Docs folder' })).toContainText(docsFolder);
    await expect(page.getByRole('region', { name: 'Sessions' }).getByRole('link', { name: new RegExp(sessionName) })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Counts' })).toContainText('Notes');

    await page.getByRole('link', { name: 'New session', exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/new\\?projectId=${project.id}`));
    await expect(page.getByTestId('new-session-project').locator('option:checked')).toHaveText(projectName);
  } finally {
    await request.post(`${api}/api/sessions/${session.id}/close`, { headers: adminHeaders });
    rmSync(docsFolder, { recursive: true, force: true });
  }
});

test('the Project home nav item opens a project page, and the switcher moves to another project', async ({ page, request }) => {
  const otherName = uniqueName('Other project');
  await request.post(`${api}/api/projects`, { headers: adminHeaders, data: { name: otherName } });
  await signInAsAdmin(page);
  await page.goto('/');

  await page.getByTestId('nav-project').click();

  await expect(page).toHaveURL(/\/project\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Switch project' }).click();
  await page.getByRole('option', { name: otherName }).click();

  await expect(page.getByRole('heading', { level: 1, name: otherName })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Docs folder' })).toContainText('No docs folder');
});
