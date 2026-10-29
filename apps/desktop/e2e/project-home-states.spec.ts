import { expect, test, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { adminHeaders, api, fulfillWithJson, interceptDaemonGet, signInAsAdmin, useFakeSessions } from './support/daemon';

const fakeSessions = useFakeSessions();

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1200, height: 800 }];
const THEMES = ['light', 'dark'] as const;
const REM_IN_PIXELS = 16;
const SKELETON_MAX_WIDTH_IN_REMS = 16;
const HOME_SIDE_PADDING_IN_PIXELS = 24;
const NO_PROJECTS = { items: [], total: 0, limit: 200, offset: 0 };

const isTruncated = (region: Locator, text: string) => region.getByText(text, { exact: true }).evaluate((element) => element.scrollWidth > element.clientWidth);

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    const scenario = `in the ${theme} theme at ${viewport.width}×${viewport.height}`;

    test(`the manager row of the project home shows the whole short name ${scenario}`, async ({ page, request }) => {
      await page.setViewportSize(viewport);
      await signInAsAdmin(page, { theme });
      const project = await (await request.post(`${api}/api/projects`, { headers: adminHeaders, data: { name: `Home ${randomUUID().slice(0, 8)}` } })).json();
      await fakeSessions.create(request, { name: 'Capitaine', model: 'sonnet', projectId: project.id, manager: { pulseSeconds: 300, childrenCap: 8, mission: 'Keep the fleet moving' } });

      await page.goto(`/project/${project.id}`);

      const managers = page.getByRole('region', { name: 'Managers' });
      await expect(managers.getByRole('link', { name: /Capitaine/ })).toBeVisible();
      await expect(managers.getByText(/pulse/)).toBeVisible();
      expect(await isTruncated(managers, 'Capitaine')).toBe(false);
    });

    test(`the project home loading skeleton is narrow and left aligned ${scenario}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await signInAsAdmin(page, { theme });
      await interceptDaemonGet(page, '/api/projects', () => new Promise<void>(() => undefined));

      await page.goto('/project');

      const skeleton = page.getByRole('status', { name: 'Loading projects' });
      await expect(skeleton).toBeVisible();
      const skeletonBox = (await skeleton.boundingBox())!;
      const homeBox = (await page.getByTestId('project-home').boundingBox())!;
      expect(skeletonBox.width).toBeLessThanOrEqual(SKELETON_MAX_WIDTH_IN_REMS * REM_IN_PIXELS);
      expect(skeletonBox.x - homeBox.x).toBeLessThanOrEqual(HOME_SIDE_PADDING_IN_PIXELS);
    });

    test(`the project home not found page quotes the missing project ${scenario}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await signInAsAdmin(page, { theme });

      await page.goto('/project/scape-old');

      await expect(page.getByRole('heading', { level: 1, name: 'Project not found' })).toBeVisible();
      await expect(page.getByRole('alert')).toContainText('“scape-old” was deleted or never existed on this daemon.');
    });

    test(`the project home empty list explains what a project groups ${scenario}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await signInAsAdmin(page, { theme });
      await interceptDaemonGet(page, '/api/projects', (route) => fulfillWithJson(route, 200, NO_PROJECTS));

      await page.goto('/project');

      await expect(page.getByRole('heading', { level: 1, name: 'No project yet' })).toBeVisible();
      await expect(page.getByText('A project groups sessions, notes, tables and handoffs under one docs folder.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create a project' })).toBeVisible();
    });
  }
}
