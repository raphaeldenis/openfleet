import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fulfillWithJson, interceptDaemonGet, signInAsAdmin } from './support/daemon';

const EMPTY_PAGE_OF_PROJECTS = { items: [], total: 0, limit: 100, offset: 0 };

const uniqueProjectName = () => `E2E project ${randomUUID().slice(0, 8)}`;
const createProjectForm = (page: Page) => page.getByRole('group', { name: 'Create a project' });

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
});

test('Settings creates a project with a docs folder, lists it with that folder and gives the focus back to the trigger', async ({ page }) => {
  const docsFolder = realpathSync(mkdtempSync(join(tmpdir(), 'of-e2e-docs-')));
  try {
    const projectName = uniqueProjectName();
    await page.goto('/settings');
    const trigger = page.getByRole('button', { name: 'Create a project…' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await trigger.click();

    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const form = createProjectForm(page);
    await expect(form.getByLabel('Name')).toBeFocused();
    await form.getByLabel('Name').fill(projectName);
    await form.getByLabel('Docs folder').fill(docsFolder);
    await form.getByRole('button', { name: 'Create project' }).click();

    await expect(page.getByTestId('projects-status')).toHaveText('Project created');
    await expect(form).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId('settings-projects')).toContainText(projectName);
    await expect(page.getByTestId('settings-projects')).toContainText(docsFolder);
  } finally {
    rmSync(docsFolder, { recursive: true, force: true });
  }
});

test('the project form refuses an empty name and a docs folder that is not an absolute path, and keeps the form open', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Create a project…' }).click();
  const form = createProjectForm(page);

  await form.getByRole('button', { name: 'Create project' }).click();

  await expect(form.getByRole('alert')).toContainText('Name is required');
  await expect(form.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByLabel('Name')).toBeFocused();

  await form.getByLabel('Name').fill(uniqueProjectName());
  await form.getByLabel('Docs folder').fill('relative/folder');
  await form.getByRole('button', { name: 'Create project' }).click();

  await expect(form.getByTestId('project-form-error')).toContainText('That folder cannot be used');
  await expect(form.getByLabel('Docs folder')).toHaveAttribute('aria-invalid', 'true');
  await expect(form).toBeVisible();
});

test('Escape cancels the project form and returns the focus to its trigger', async ({ page }) => {
  await page.goto('/settings');
  const trigger = page.getByRole('button', { name: 'Create a project…' });
  await trigger.click();
  await expect(createProjectForm(page)).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(createProjectForm(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('the New session form with no project offers to create one and selects the project it creates', async ({ page }) => {
  await interceptDaemonGet(page, '/api/projects', (route) => fulfillWithJson(route, 200, EMPTY_PAGE_OF_PROJECTS));
  const projectName = uniqueProjectName();
  await page.goto('/new');
  await expect(page.getByTestId('new-session-no-projects')).toContainText('No projects yet');

  await page.getByRole('button', { name: 'Create a project…' }).click();
  const form = createProjectForm(page);
  await form.getByLabel('Name').fill(projectName);
  await form.getByRole('button', { name: 'Create project' }).click();

  await expect(form).toHaveCount(0);
  await expect(page.getByTestId('new-session-status')).toHaveText('Project created');
  const projectSelect = page.getByTestId('new-session-project');
  await expect(projectSelect.locator('option:checked')).toHaveText(projectName);
  await expect(projectSelect).toBeFocused();
  await expect(page.getByTestId('new-session-no-projects')).toHaveCount(0);
});
