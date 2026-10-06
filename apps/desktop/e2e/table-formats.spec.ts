import { expect, test } from '@playwright/test';
import { fulfillWithJson, interceptDaemonGet, signInAsAdmin } from './support/daemon';

test('history displays escaped long text on separate visible lines', async ({ page }) => {
  await signInAsAdmin(page);
  const project = { id: 'format-project', name: 'Formats', directory: '/tmp', createdAt: '2026-10-06T08:00:00Z' };
  const store = { id: 'format-store', projectId: project.id, displayName: 'Formats', createdAt: '2026-10-06T08:00:00Z', updatedAt: '2026-10-06T08:00:00Z' };
  const column = { id: 'details', storeId: store.id, displayName: 'Details', columnType: 'text', format: 'longText', sortOrder: 0, options: null };
  const row = { id: 'format-row', storeId: store.id, createdAt: store.createdAt, updatedAt: store.updatedAt, data: { details: 'First line\nSecond line <script>' } };
  const paged = (items: unknown[]) => ({ items, total: items.length, limit: 1000, offset: 0 });
  await interceptDaemonGet(page, '/api/projects', (route) => fulfillWithJson(route, 200, paged([project])));
  await interceptDaemonGet(page, '/api/data-stores', (route) => fulfillWithJson(route, 200, paged([store])));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}`, (route) => fulfillWithJson(route, 200, { ...store, columns: [column] }));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}/rows`, (route) => fulfillWithJson(route, 200, paged([row])));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}/views`, (route) => fulfillWithJson(route, 200, { items: [] }));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}/rows/${row.id}/changes`, (route) => fulfillWithJson(route, 200, paged([{
    id: 'format-history', rowId: row.id, actorKind: 'human', actorLabel: 'You', createdAt: store.createdAt,
    change: { details: { from: null, to: row.data.details } },
  }])));
  await page.goto(`/tables?projectId=${project.id}`);
  await page.getByTestId(`grid-cell-${row.id}-details`).click();
  const history = page.getByTestId('history-entry-format-history');
  const firstLine = history.getByText('Details — → First line', { exact: true });
  const secondLine = history.getByText('Second line <script>', { exact: true });
  await expect(firstLine).toBeVisible();
  await expect(secondLine).toBeVisible();
  const firstBounds = await firstLine.boundingBox();
  const secondBounds = await secondLine.boundingBox();
  expect(firstBounds).not.toBeNull();
  expect(secondBounds).not.toBeNull();
  expect(secondBounds!.y).toBeGreaterThanOrEqual(firstBounds!.y + firstBounds!.height);
});
