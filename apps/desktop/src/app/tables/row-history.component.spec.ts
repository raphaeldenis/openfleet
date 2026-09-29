import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import type { DsColumn, DsRowHistoryEntry } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { RowHistoryComponent } from './row-history.component';

const columns: DsColumn[] = [
  { id: 'c-status', storeId: 's1', displayName: 'Status', columnType: 'text', options: null, sortOrder: 0 },
];

const entry = (overrides: Partial<DsRowHistoryEntry> & Pick<DsRowHistoryEntry, 'id' | 'change'>): DsRowHistoryEntry => ({
  rowId: 'r1',
  actorKind: 'agent',
  actorLabel: 'Gimli · T6',
  createdAt: '2026-09-29T14:10:00.000Z',
  ...overrides,
});

const entries: DsRowHistoryEntry[] = [
  entry({ id: 'h3', change: { 'c-status': { from: 'doing', to: 'review' } } }),
  entry({ id: 'h2', actorKind: 'trigger', actorLabel: 'Backlog row → worker', change: { 'c-status': { from: null, to: 'todo' } } }),
  entry({ id: 'h1', actorKind: 'human', actorLabel: 'You', change: { kind: 'create' } }),
];

const bindings = () => [inputBinding('entries', () => entries), inputBinding('columns', () => columns)];

describe('RowHistoryComponent', () => {
  it('user sees who changed the row, with a badge for the kind of actor', async () => {
    await render(RowHistoryComponent, { bindings: bindings() });

    expect(screen.getByTestId('history-entry-h3')).toHaveTextContent('Gimli · T6');
    expect(screen.getByTestId('history-entry-h3')).toHaveTextContent('AGENT');
    expect(screen.getByTestId('history-entry-h2')).toHaveTextContent('TRIGGER');
    expect(screen.getByTestId('history-entry-h1')).toHaveTextContent('HUMAN');
  });

  it('user reads a field change as column name, old value and new value', async () => {
    await render(RowHistoryComponent, { bindings: bindings() });

    expect(screen.getByTestId('history-entry-h3')).toHaveTextContent('Status doing → review');
  });

  it('user reads a first-time value as coming from empty', async () => {
    await render(RowHistoryComponent, { bindings: bindings() });

    expect(screen.getByTestId('history-entry-h2')).toHaveTextContent('Status — → todo');
  });

  it('user reads a creation as "created row"', async () => {
    await render(RowHistoryComponent, { bindings: bindings() });

    expect(screen.getByTestId('history-entry-h1')).toHaveTextContent('created row');
  });

  it('user reads a deletion as "deleted row"', async () => {
    await render(RowHistoryComponent, {
      bindings: [inputBinding('entries', () => [entry({ id: 'h9', change: { kind: 'delete' } })])],
    });

    expect(screen.getByTestId('history-entry-h9')).toHaveTextContent('deleted row');
  });

  it('user sees a hint when the row has no recorded changes', async () => {
    await render(RowHistoryComponent, { bindings: [inputBinding('entries', () => [])] });

    expect(screen.getByTestId('history-empty')).toBeTruthy();
  });

  it('user sees the heading of the row whose history is open', async () => {
    await render(RowHistoryComponent, {
      bindings: [...bindings(), inputBinding('heading', () => 'Desktop reconnect with backoff')],
    });

    expect(screen.getByTestId('history-heading')).toHaveTextContent('Desktop reconnect with backoff');
  });
});
