import { expect, test } from '@playwright/test';
import { fulfillWithJson, interceptDaemonGet, signInAsAdmin } from './support/daemon';

const VIEWPORTS = [{ width: 1200, height: 800 }, { width: 1440, height: 900 }];
const COLUMN_NAMES = ['status', 'pr_url', 'step', 'title', 'tag'];
const SCROLLBAR_HEIGHT_PX = 8;

for (const viewport of VIEWPORTS) {
  test(`the grid keeps a visible horizontal scrollbar when the Row details panel narrows it at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signInAsAdmin(page);
    const project = { id: 'scroll-project', name: 'Scroll', directory: '/tmp', createdAt: '2026-10-06T08:00:00Z' };
    const store = { id: 'scroll-store', projectId: project.id, displayName: 'Scroll', createdAt: project.createdAt, updatedAt: project.createdAt };
    const columns = COLUMN_NAMES.map((name, sortOrder) => ({ id: name, storeId: store.id, displayName: name, columnType: 'text', format: null, sortOrder, options: null }));
    const row = { id: 'scroll-row', storeId: store.id, createdAt: store.createdAt, updatedAt: store.updatedAt, data: Object.fromEntries(COLUMN_NAMES.map((name) => [name, `${name} value`])) };
    const paged = (items: unknown[]) => ({ items, total: items.length, limit: 1000, offset: 0 });
    await interceptDaemonGet(page, '/api/projects', (route) => fulfillWithJson(route, 200, paged([project])));
    await interceptDaemonGet(page, '/api/data-stores', (route) => fulfillWithJson(route, 200, paged([store])));
    await interceptDaemonGet(page, `/api/data-stores/${store.id}`, (route) => fulfillWithJson(route, 200, { ...store, columns }));
    await interceptDaemonGet(page, `/api/data-stores/${store.id}/rows`, (route) => fulfillWithJson(route, 200, paged([row])));
    await interceptDaemonGet(page, `/api/data-stores/${store.id}/views`, (route) => fulfillWithJson(route, 200, { items: [] }));
    await interceptDaemonGet(page, `/api/data-stores/${store.id}/rows/${row.id}/changes`, (route) => fulfillWithJson(route, 200, paged([])));

    await page.goto(`/tables?projectId=${project.id}`);
    await page.getByTestId(`grid-row-${row.id}`).click();
    await expect(page.getByRole('region', { name: 'Row details' })).toBeVisible();

    const grid = page.getByTestId('table-grid');
    const { scrollWidth, clientWidth, scrollbarHeight } = await grid.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollbarHeight: getComputedStyle(element, '::-webkit-scrollbar').height,
    }));
    const lastHeader = page.getByTestId('grid-header-tag');

    if (viewport.width === 1200) expect(scrollWidth).toBeGreaterThan(clientWidth);
    expect(scrollbarHeight).toBe(`${SCROLLBAR_HEIGHT_PX}px`);
    await lastHeader.scrollIntoViewIfNeeded();
    await expect(lastHeader).toBeInViewport();
  });
}
