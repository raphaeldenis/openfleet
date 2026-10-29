import type { Page } from '@playwright/test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** An existing, writable folder to hand to the project step, so a run never creates folders under the real home. */
export function makeDocsFolder(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'of-e2e-project-docs-')));
}

/** Fills the Project step with a name and an existing docs folder, then creates the project. */
export async function createOnboardingProject(page: Page, { name, docsFolder }: { name: string; docsFolder: string }): Promise<void> {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Use an existing folder' }).click();
  await page.getByLabel('Specs and docs are saved in').fill(docsFolder);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
}
