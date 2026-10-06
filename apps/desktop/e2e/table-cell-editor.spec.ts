import { expect, test } from '@playwright/test';
import { api, fulfillWithJson, interceptDaemonGet, signInAsAdmin } from './support/daemon';

test('edits from the keyboard, keeps rejected input and refreshes row details and history', async ({ page }) => {
  await signInAsAdmin(page);
  const project = { id: 'editor-project', name: 'Editor', directory: '/tmp', createdAt: '2026-10-06T08:00:00Z' };
  const store = { id: 'editor-store', projectId: project.id, displayName: 'Editor', createdAt: project.createdAt, updatedAt: project.createdAt };
  const columns = [
    { id: 'details', storeId: store.id, displayName: 'Details', columnType: 'text', format: 'longText', sortOrder: 0, options: null },
    { id: 'link', storeId: store.id, displayName: 'Link', columnType: 'text', format: 'url', sortOrder: 1, options: null },
  ];
  let row = { id: 'editor-row', storeId: store.id, createdAt: store.createdAt, updatedAt: store.updatedAt, data: { details: 'Original', link: 'https://example.com/task' } };
  let writes = 0;
  const paged = (items: unknown[]) => ({ items, total: items.length, limit: 1000, offset: 0 });
  await interceptDaemonGet(page, '/api/projects', (route) => fulfillWithJson(route, 200, paged([project])));
  await interceptDaemonGet(page, '/api/data-stores', (route) => fulfillWithJson(route, 200, paged([store])));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}`, (route) => fulfillWithJson(route, 200, { ...store, columns }));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}/rows`, (route) => fulfillWithJson(route, 200, paged([row])));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}/views`, (route) => fulfillWithJson(route, 200, { items: [] }));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}/rows/${row.id}/changes`, (route) => fulfillWithJson(route, 200, paged(writes > 1 ? [{
    id: 'editor-history', rowId: row.id, actorKind: 'human', actorLabel: 'You', createdAt: store.createdAt,
    change: { details: { from: 'Original', to: row.data.details } },
  }] : [])));
  await page.route((url) => url.origin === api && url.pathname === `/api/data-stores/${store.id}/rows`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    writes++;
    if (writes === 1) return fulfillWithJson(route, 400, { error: 'invalid_body', kind: 'invalid_request', retry: 'never', message: 'Rejected' });
    expect(route.request().postDataJSON()).toEqual({ projectId: project.id, updates: [{ rowId: row.id, patch: { details: 'First\nSecond' } }] });
    row = { ...row, data: { ...row.data, details: 'First\nSecond' } };
    return fulfillWithJson(route, 200, { items: [row] });
  });
  await page.goto(`/tables?projectId=${project.id}`);
  const gridRow = page.getByTestId(`grid-row-${row.id}`);
  await gridRow.focus();
  await page.keyboard.press('Enter');
  const details = page.getByRole('region', { name: 'Row details' });
  const editButton = details.getByRole('button', { name: 'Edit Details' });
  await editButton.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: /Edit Details/ });
  const input = dialog.getByLabel('Details', { exact: true });
  await expect(input).toBeFocused();
  await input.fill('First\nSecond');
  await page.keyboard.press('Control+Enter');
  await expect(dialog.getByRole('alert')).toContainText('refused');
  await expect(input).toHaveValue('First\nSecond');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editButton).toBeFocused();
  await expect(page.getByTestId('history-entry-editor-history')).toContainText('You');
  await expect(details).toContainText('First\nSecond');
  expect(writes).toBe(2);
  await editButton.click();
  await input.fill('Cancelled');
  await page.keyboard.press('Escape');
  await expect(editButton).toBeFocused();
  await expect(details).toContainText('First\nSecond');
  expect(writes).toBe(2);
  const popupOpened = page.waitForEvent('popup');
  await details.getByRole('link').click();
  const popup = await popupOpened;
  await expect(popup).toHaveURL('https://example.com/task');
  await popup.close();
  await expect(page.getByTestId('tables-history')).toBeVisible();
});
