import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminHeaders, api, fulfillWithJson, interceptDaemonGet, interceptDaemonPost, signInAsAdmin } from './support/daemon';
import { createOnboardingProject } from './support/onboardingProject';

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

const DEFERRED_STEP_LABEL = 'Available in a later phase';
const FIRST_SESSION_NAME = 'First session';
const DAEMON_POLL_GRACE_MS = 8_000;

const uniqueProjectName = () => `Journey project ${randomUUID().slice(0, 8)}`;
const step = (page: Page, name: string) => page.getByRole('list', { name: 'Setup steps' }).getByRole('listitem').filter({ hasText: name });
const docsFolderField = (page: Page) => page.getByLabel('Specs and docs are saved in');

/** A first run: the fleet has no session yet, so the daemon step leads on to the project step instead of back to the app. */
async function startAFirstRunOnABlankFleet(page: Page, theme: Theme): Promise<void> {
  await signInAsAdmin(page, { theme });
  await interceptDaemonGet(page, '/api/sessions', (route) => fulfillWithJson(route, 200, []));
}

/** Creates the first session on the daemon's fake harness, so no real CLI starts; hands back the ids to close afterwards. */
async function createFirstSessionsOnTheFakeHarness(page: Page, createdSessionIds: string[]): Promise<void> {
  await interceptDaemonPost(page, '/api/sessions', async (route) => {
    const requestedSession = route.request().postDataJSON();
    const response = await route.fetch({ postData: JSON.stringify({ ...requestedSession, harness: 'fake' }) });
    const createdSession = await response.json();
    createdSessionIds.push(createdSession.id);
    await fulfillWithJson(route, response.status(), createdSession);
  });
}

async function createTheProject(page: Page, { name, docsFolder }: { name: string; docsFolder: string }): Promise<void> {
  await createOnboardingProject(page, { name, docsFolder });
  await expect(page.getByText(`Project ready: ${name}`)).toBeVisible();
}

const createdSessionIds: string[] = [];
let docsFolder: string;

test.beforeEach(() => {
  docsFolder = realpathSync(mkdtempSync(join(tmpdir(), 'of-e2e-journey-docs-')));
});

test.afterEach(async ({ request }) => {
  rmSync(docsFolder, { recursive: true, force: true });
  for (const id of createdSessionIds.splice(0)) await request.post(`${api}/api/sessions/${id}/close`, { headers: adminHeaders });
});

for (const theme of THEMES) {
  test.describe(`onboarding journey, ${theme} theme`, () => {
    test('the daemon step waits with the manual start card while the daemon is unreachable, then moves on to the project step on its own', async ({ page }) => {
      await startAFirstRunOnABlankFleet(page, theme);
      let isDaemonReachable = false;
      await interceptDaemonGet(page, '/health', (route) => (isDaemonReachable ? route.fallback() : fulfillWithJson(route, 503, { ok: false })));

      await page.goto('/onboarding');

      await expect(page.getByRole('heading', { name: 'Start the OpenFleet daemon' })).toBeVisible();
      await expect(page.getByTestId('daemon-manual')).toContainText('pnpm dev:core');
      await expect(step(page, 'Daemon')).toHaveAttribute('data-state', 'current');
      await expect(page.getByTestId('onboarding-step-project')).toHaveCount(0);
      for (const deferredStep of ['Providers', 'Playbooks', 'Team']) {
        await expect(step(page, deferredStep)).toContainText(DEFERRED_STEP_LABEL);
        await expect(step(page, deferredStep)).toHaveAttribute('data-state', 'upcoming');
      }

      isDaemonReachable = true;

      await expect(page.getByTestId('onboarding-step-project')).toBeVisible({ timeout: DAEMON_POLL_GRACE_MS });
      await expect(page.getByRole('heading', { name: 'Define the project' })).toBeVisible();
      await expect(step(page, 'Daemon')).toHaveAttribute('data-state', 'done');
      await expect(step(page, 'Project')).toHaveAttribute('data-state', 'current');
      await expect(step(page, 'Providers')).toHaveAttribute('data-state', 'upcoming');
    });

    test('the project step keeps Continue disabled when empty and when the repository path matches no project', async ({ page }) => {
      await startAFirstRunOnABlankFleet(page, theme);

      await page.goto('/onboarding');

      await expect(page.getByTestId('onboarding-step-project')).toBeVisible();
      const continueButton = page.getByRole('button', { name: 'Continue' });
      await expect(continueButton).toBeDisabled();
      await page.getByLabel('Repository path').fill('/tmp');
      await expect(continueButton).toBeDisabled();
    });

    test('the project step refuses an empty name and a docs folder that is not an absolute path, then creates the project and shows it', async ({ page }) => {
      await startAFirstRunOnABlankFleet(page, theme);
      await page.goto('/onboarding');

      await page.getByRole('button', { name: 'Create project' }).click();

      await expect(page.getByRole('alert')).toContainText('Name is required');
      await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByText(/Project ready/)).toHaveCount(0);

      const projectName = uniqueProjectName();
      await page.getByLabel('Name', { exact: true }).fill(projectName);
      await page.getByRole('button', { name: 'Use an existing folder' }).click();
      await docsFolderField(page).fill('relative/folder');
      await page.getByRole('button', { name: 'Create project' }).click();

      await expect(page.getByTestId('project-form-error')).toContainText('That folder cannot be used');
      await expect(docsFolderField(page)).toHaveAttribute('aria-invalid', 'true');
      await expect(docsFolderField(page)).toBeFocused();
      await expect(page.getByText(/Project ready/)).toHaveCount(0);

      await docsFolderField(page).fill(docsFolder);
      await page.getByRole('button', { name: 'Create project' }).click();

      await expect(page.getByText(`Project ready: ${projectName}`)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create project' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    });

    test('reloading the project step finds the project again, ready to continue, without creating a second one', async ({ page }) => {
      await startAFirstRunOnABlankFleet(page, theme);
      await page.goto('/onboarding');
      const projectName = uniqueProjectName();
      await page.getByLabel('Repository path').fill('/tmp');
      await createTheProject(page, { name: projectName, docsFolder });

      await page.reload();

      await expect(page.getByText(`Project ready: ${projectName}`)).toBeVisible();
      await expect(page.getByLabel('Repository path')).toHaveValue('/tmp');
      await expect(page.getByRole('button', { name: 'Create project' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
      const { items } = await (await page.request.get(`${api}/api/projects`, { headers: adminHeaders })).json();
      expect(items.filter((project: { name: string }) => project.name === projectName)).toHaveLength(1);
    });

    test('the whole journey creates a project, starts the first session on it and leaves onboarding for that session', async ({ page }) => {
      await startAFirstRunOnABlankFleet(page, theme);
      await createFirstSessionsOnTheFakeHarness(page, createdSessionIds);
      const projectName = uniqueProjectName();
      await page.goto('/onboarding');
      await createTheProject(page, { name: projectName, docsFolder });
      await page.getByLabel('Repository path').fill('/tmp');

      await page.getByRole('button', { name: 'Continue' }).click();

      await expect(page.getByTestId('onboarding-step-first-session')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Start your first session' })).toBeVisible();
      await expect(step(page, 'Daemon')).toHaveAttribute('data-state', 'done');
      await expect(step(page, 'Project')).toHaveAttribute('data-state', 'done');
      await expect(step(page, 'First session')).toHaveAttribute('data-state', 'current');
      await expect(page.getByTestId('new-session-directory')).toHaveValue('/tmp');
      await expect(page.getByTestId('new-session-name')).toHaveValue(FIRST_SESSION_NAME);
      await expect(page.getByTestId('new-session-project').locator('option:checked')).toHaveText(projectName);

      await page.getByRole('button', { name: 'Create session' }).click();

      await expect(page).toHaveURL(/\/session\/[^/]+$/);
      await expect(page.getByTestId('onboarding')).toHaveCount(0);
      expect(createdSessionIds).toHaveLength(1);
      await expect(page).toHaveURL(new RegExp(`/session/${createdSessionIds[0]}$`));
    });

    test('Back on the first-session step returns to the project step with the project kept, and a blank directory is refused', async ({ page }) => {
      await startAFirstRunOnABlankFleet(page, theme);
      const projectName = uniqueProjectName();
      await page.goto('/onboarding');
      await createTheProject(page, { name: projectName, docsFolder });
      await page.getByLabel('Repository path').fill('/tmp');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByTestId('new-session-directory').fill('');

      await page.getByRole('button', { name: 'Create session' }).click();

      await expect(page.getByTestId('new-session-directory-error')).toContainText('Directory is required');
      await expect(page).toHaveURL(/\/onboarding$/);

      await page.getByRole('button', { name: 'Back' }).click();

      await expect(page.getByTestId('onboarding-step-project')).toBeVisible();
      await expect(step(page, 'Project')).toHaveAttribute('data-state', 'current');
      await expect(page.getByText(`Project ready: ${projectName}`)).toBeVisible();
      await expect(page.getByLabel('Repository path')).toHaveValue('/tmp');
      await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
    });

    test('Skip to app leaves onboarding for the app home', async ({ page }) => {
      await startAFirstRunOnABlankFleet(page, theme);
      await page.goto('/onboarding');
      await expect(page.getByTestId('onboarding-step-project')).toBeVisible();

      await page.getByRole('link', { name: 'Skip to app →' }).click();

      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId('onboarding')).toHaveCount(0);
      await expect(page.getByTestId('app-shell')).toBeVisible();
    });

    test('Run setup again in Settings opens the setup, which sends a reachable daemon straight back to Settings', async ({ page }) => {
      await signInAsAdmin(page, { theme });
      await page.goto('/settings');

      await page.getByTestId('general-run-setup').click();

      await expect(page).toHaveURL(/\/settings$/);
      await expect(page.getByTestId('onboarding')).toHaveCount(0);
      await expect(page.getByTestId('general-run-setup')).toBeVisible();
    });
  });
}
