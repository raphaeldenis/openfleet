import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fulfillWithJson, interceptDaemonGet, signInAsAdmin } from './support/daemon';

const THEMES = ['light', 'dark'] as const;
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1200, height: 800 }];
const SCRATCH_ROOT = join(__dirname, '..', '..', '..', '.scratch');

async function openProjectStep(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await signInAsAdmin(page, { theme });
  await interceptDaemonGet(page, '/api/sessions', (route) => fulfillWithJson(route, 200, []));
  await page.goto('/onboarding');
  await expect(page.getByTestId('onboarding-step-project')).toBeVisible();
}

/** A scratch repository with a pnpm lockfile and a test script, inside the home folder the daemon is allowed to read. */
function makeScratchRepository(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const repository = mkdtempSync(join(SCRATCH_ROOT, 'of-e2e-detect-'));
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ name: 'scratch', scripts: { test: 'vitest run', build: 'tsc' } }));
  writeFileSync(join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  return repository;
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test.describe(`project step at ${viewport.width}×${viewport.height}, ${theme} theme`, () => {
      test.use({ viewport });

      test('shows every field of the mockup, with the note preview beside them, inside the window', async ({ page }) => {
        await openProjectStep(page, theme);

        for (const label of ['Name', 'Goal · one paragraph', 'Repository path', 'Stack', 'install', 'build', 'test', 'dev server', 'Use an existing folder']) {
          await expect(page.getByLabel(label, { exact: true }).or(page.getByRole('button', { name: label, exact: true })).first()).toBeVisible();
        }
        await expect(page.getByRole('button', { name: 'Change…' })).toBeVisible();
        await expect(page.getByTestId('docs-folder-block')).toContainText('specs/ plans/ handoffs/ reports/');
        const fieldsBox = await page.getByLabel('Name', { exact: true }).boundingBox();
        const previewBox = await page.getByTestId('note-preview').boundingBox();
        expect(fieldsBox).not.toBeNull();
        expect(previewBox).not.toBeNull();
        expect(previewBox!.x).toBeGreaterThan(fieldsBox!.x + fieldsBox!.width);
        const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(hasHorizontalOverflow).toBe(false);
        expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(viewport.width);
      });

      test('the proposed folder and the note preview follow the typed name, and the preview follows the goal and stack', async ({ page }) => {
        await openProjectStep(page, theme);

        await page.getByLabel('Name', { exact: true }).fill('Atlas');
        await page.getByLabel('Goal · one paragraph').fill('Map the fleet');
        await page.getByLabel('Stack', { exact: true }).fill('Angular');
        await page.getByLabel('Stack', { exact: true }).press('Enter');

        await expect(page.getByTestId('docs-folder-path')).toContainText('Atlas');
        const preview = page.getByTestId('note-preview');
        await expect(preview).toContainText('# Project: Atlas');
        await expect(preview).toContainText('Map the fleet');
        await expect(preview).toContainText('- Angular');
        await page.getByRole('button', { name: 'Remove Angular' }).click();
        await expect(preview).not.toContainText('- Angular');
      });

      test('detects the commands of a repository and labels them detected', async ({ page }) => {
        const repository = makeScratchRepository();
        await openProjectStep(page, theme);

        await page.getByLabel('Repository path').fill(repository);
        await page.getByLabel('Repository path').blur();

        await expect(page.getByLabel('test', { exact: true })).toHaveValue('pnpm test');
        await expect(page.getByLabel('build', { exact: true })).toHaveValue('pnpm run build');
        await expect(page.getByTestId('detected-label').first()).toBeVisible();
        await expect(page.getByTestId('note-preview')).toContainText('- test: `pnpm test`');
      });
    });
  }
}
