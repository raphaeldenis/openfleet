import { inputBinding } from '@angular/core';
import { render, screen } from '@testing-library/angular/zoneless';
import type { DsColumn, DsRow } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { RowDetailsComponent } from './row-details.component';

const urlColumn: DsColumn = { id: 'link', storeId: 'store', displayName: 'Link', columnType: 'text', format: 'url', sortOrder: 0, options: null };
const row: DsRow = { id: 'row-1', storeId: 'store', data: { link: 'https://example.test' }, rev: 1, createdAt: '2026-10-06T10:09:10+02:00', updatedAt: '2026-10-06T10:09:10+02:00' };

describe('row details', () => {
  it('draws each edit action with the shared secondary button', async () => {
    await render(RowDetailsComponent, { bindings: [inputBinding('row', () => row), inputBinding('columns', () => [urlColumn])] });

    const editLink = screen.getByRole('button', { name: 'Edit Link' });

    expect(editLink).toHaveClass('of-btn', 'of-btn--secondary', 'of-btn--compact');
  });
});
