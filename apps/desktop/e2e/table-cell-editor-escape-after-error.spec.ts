import { expect, test } from '@playwright/test';
import { api, fulfillWithJson, interceptDaemonGet, signInAsAdmin } from './support/daemon';

test('after a refused save the editor keeps the draft, keeps the focus inside and closes on Escape with the focus back on the opener', async ({ page }) => {
  await signInAsAdmin(page);
  const project = { id: 'escape-project', name: 'Escape', directory: '/tmp', createdAt: '2026-10-06T08:00:00Z' };
  const store = { id: 'escape-store', projectId: project.id, displayName: 'Escape', createdAt: project.createdAt, updatedAt: project.createdAt };
  const columns = [{ id: 'details', storeId: store.id, displayName: 'Details', columnType: 'text', format: 'longText', sortOrder: 0, options: null }];
  const row = { id: 'escape-row', storeId: store.id, createdAt: store.createdAt, updatedAt: store.updatedAt, data: { details: 'Original' } };
  const paged = (items: unknown[]) => ({ items, total: items.length, limit: 1000, offset: 0 });
  await interceptDaemonGet(page, '/api/projects', (route) => fulfillWithJson(route, 200, paged([project])));
  await interceptDaemonGet(page, '/api/data-stores', (route) => fulfillWithJson(route, 200, paged([store])));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}`, (route) => fulfillWithJson(route, 200, { ...store, columns }));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}/rows`, (route) => fulfillWithJson(route, 200, paged([row])));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}/views`, (route) => fulfillWithJson(route, 200, { items: [] }));
  await interceptDaemonGet(page, `/api/data-stores/${store.id}/rows/${row.id}/changes`, (route) => fulfillWithJson(route, 200, paged([])));
  await page.route((url) => url.origin === api && url.pathname === `/api/data-stores/${store.id}/rows`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    return fulfillWithJson(route, 400, { error: 'invalid_body', kind: 'invalid_request', retry: 'never', message: 'Rejected' });
  });
  await page.goto(`/tables?projectId=${project.id}`);
  await page.getByTestId(`grid-row-${row.id}`).focus();
  await page.keyboard.press('Enter');
  const details = page.getByRole('region', { name: 'Row details' });
  const editButton = details.getByRole('button', { name: 'Edit Details' });
  await editButton.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: /Edit Details/ });
  const input = dialog.getByLabel('Details', { exact: true });
  await input.fill('Draft kept');

  await page.keyboard.press('Control+Enter');
  await expect(dialog.getByRole('alert')).toContainText('refused');

  await expect(input).toHaveValue('Draft kept');
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(editButton).toBeFocused();
});
