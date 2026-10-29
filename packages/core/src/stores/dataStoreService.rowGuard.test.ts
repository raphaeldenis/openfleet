import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DataStoreRepository } from './dataStoreRepository.js';
import { DataStoreService, DoneWithoutPrUrlError, JournalShortenedError, RowGuardViolationError } from './dataStoreService.js';

const scope = { projectId: 'p1' } as const;
const human = { kind: 'human', label: 'You' } as const;
const statusOptions = [{ id: 'todo', label: 'todo' }, { id: 'done', label: 'done' }];
const stepOptions = [{ id: 'build', label: 'build' }, { id: 'cancelled', label: 'cancelled' }];

function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

function kanban(options: { guardEnabled: boolean }) {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  if (options.guardEnabled) projects.update('p1', { rowGuardEnabled: true });
  let counter = 0;
  const service = new DataStoreService({ repo: new DataStoreRepository(db), db, clock: () => '2026-01-01T00:00:00.000Z', newId: () => `id-${++counter}` });
  const store = service.createStore({ ...scope, displayName: 'kanban' });
  const column = (displayName: string, columnType: 'text' | 'select', selectOptions?: { id: string; label: string }[]) =>
    service.addColumn(store.id, { ...scope, displayName, columnType, ...(selectOptions ? { options: selectOptions } : {}) }).id;
  const cols = { journal: column('journal', 'text'), prUrl: column('pr_url', 'text'), status: column('status', 'select', statusOptions), step: column('step', 'select', stepOptions) };
  const insert = (data: Record<string, unknown>) => service.insertRow(store.id, { ...scope, data, actor: human });
  const patch = (rowId: string, cells: Record<string, unknown>) => () => service.updateRow(store.id, rowId, { ...scope, patch: cells, actor: human });
  return { service, store, cols, insert, patch };
}

const firstLine = '2026-10-29T06:57Z [Capitaine] builder lance.';
const secondLine = '2026-10-29T07:10Z [builder] conception envoyée.';
const journalWithTwoLines = `${firstLine}\n${secondLine}`;

describe('row guard (setting on)', () => {
  it('refuses a journal that is shorter than the previous one', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.journal]: journalWithTwoLines });

    const error = thrownBy(patch(row.id, { [cols.journal]: firstLine }));

    expect(error).toBeInstanceOf(JournalShortenedError);
    expect(error).toBeInstanceOf(RowGuardViolationError);
  });

  it('refuses a journal replaced by another text of the same length', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.journal]: firstLine });

    const error = thrownBy(patch(row.id, { [cols.journal]: firstLine.toUpperCase() }));

    expect(error).toBeInstanceOf(JournalShortenedError);
  });

  it('refuses a journal replaced by an unrelated longer text', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.journal]: firstLine });

    const error = thrownBy(patch(row.id, { [cols.journal]: `unrelated ${firstLine} and more` }));

    expect(error).toBeInstanceOf(JournalShortenedError);
  });

  it.each([['null', null], ['an empty string', '']])('refuses a journal cleared to %s', (_label, cleared) => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.journal]: firstLine });

    const error = thrownBy(patch(row.id, { [cols.journal]: cleared }));

    expect(error).toBeInstanceOf(JournalShortenedError);
  });

  it('tells the caller to resend the previous journal followed by the new line', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.journal]: firstLine });

    const error = thrownBy(patch(row.id, { [cols.journal]: 'x' })) as Error;

    expect(error.message).toMatch(/previous journal/i);
    expect(error.message).toMatch(/new line/i);
  });

  it('accepts a journal that is the previous one followed by a new line', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.journal]: firstLine });

    const updated = patch(row.id, { [cols.journal]: journalWithTwoLines })();

    expect(updated.data[cols.journal]).toBe(journalWithTwoLines);
  });

  it('accepts the same journal sent again', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.journal]: firstLine });

    expect(patch(row.id, { [cols.journal]: firstLine })().data[cols.journal]).toBe(firstLine);
  });

  it.each([['absent', undefined], ['null', null], ['empty', '']])('accepts any journal when the previous journal is %s', (_label, initial) => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert(initial === undefined ? {} : { [cols.journal]: initial });

    expect(patch(row.id, { [cols.journal]: firstLine })().data[cols.journal]).toBe(firstLine);
  });

  it('accepts a journal that differs only by Unicode normalization form', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const decomposedLine = 'réunion terminée'.normalize('NFD');
    const row = insert({ [cols.journal]: decomposedLine });

    const updated = patch(row.id, { [cols.journal]: `${'réunion terminée'.normalize('NFC')}\nsuite` })();

    expect(updated.data[cols.journal]).toContain('suite');
  });

  it('ignores a patch that does not touch the journal', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.journal]: firstLine });

    expect(patch(row.id, { [cols.step]: 'build' })().data[cols.journal]).toBe(firstLine);
  });

  it('refuses a shortened journal in a batch update and keeps every row untouched', () => {
    const { service, store, cols, insert } = kanban({ guardEnabled: true });
    const first = insert({ [cols.journal]: firstLine });
    const second = insert({ [cols.journal]: journalWithTwoLines });

    const error = thrownBy(() => service.updateRows(store.id, {
      ...scope, actor: human,
      items: [{ rowId: first.id, patch: { [cols.journal]: `${firstLine}\nok` } }, { rowId: second.id, patch: { [cols.journal]: 'short' } }],
    }));

    expect(error).toBeInstanceOf(JournalShortenedError);
    expect(service.query(store.id, scope).find((row) => row.id === first.id)?.data[cols.journal]).toBe(firstLine);
  });

  it('refuses a shortened journal through a filtered update', () => {
    const { service, store, cols, insert } = kanban({ guardEnabled: true });
    insert({ [cols.journal]: journalWithTwoLines, [cols.step]: 'build' });

    const error = thrownBy(() => service.updateRowsWhere(store.id, { ...scope, where: [{ columnId: cols.step, op: 'eq', value: 'build' }], set: { [cols.journal]: 'short' }, actor: human }));

    expect(error).toBeInstanceOf(JournalShortenedError);
  });

  it('refuses moving to done without a pr_url', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.status]: 'todo' });

    const error = thrownBy(patch(row.id, { [cols.status]: 'done' }));

    expect(error).toBeInstanceOf(DoneWithoutPrUrlError);
    expect(error).toBeInstanceOf(RowGuardViolationError);
  });

  it('accepts moving to done when the pr_url is set in the same patch', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.status]: 'todo' });

    const updated = patch(row.id, { [cols.status]: 'done', [cols.prUrl]: 'https://example.test/pr/1' })();

    expect(updated.data[cols.status]).toBe('done');
  });

  it('accepts moving to done when the pr_url was already set', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.status]: 'todo', [cols.prUrl]: 'https://example.test/pr/1' });

    expect(patch(row.id, { [cols.status]: 'done' })().data[cols.status]).toBe('done');
  });

  it('accepts moving to done without a pr_url when the step is cancelled', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.status]: 'todo', [cols.step]: 'cancelled' });

    expect(patch(row.id, { [cols.status]: 'done' })().data[cols.status]).toBe('done');
  });

  it('refuses clearing the pr_url of a row that is already done', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.status]: 'done', [cols.prUrl]: 'https://example.test/pr/1' });

    const error = thrownBy(patch(row.id, { [cols.prUrl]: null }));

    expect(error).toBeInstanceOf(DoneWithoutPrUrlError);
  });

  it('does not touch a row that is already done and unrelated edits', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: true });
    const row = insert({ [cols.status]: 'done', [cols.step]: 'cancelled' });

    expect(patch(row.id, { [cols.journal]: firstLine })().data[cols.journal]).toBe(firstLine);
  });

  it('leaves a store without journal, pr_url or status columns alone', () => {
    const { service, cols } = kanban({ guardEnabled: true });
    const plain = service.createStore({ ...scope, displayName: 'plain' });
    const note = service.addColumn(plain.id, { ...scope, displayName: 'note', columnType: 'text' }).id;
    const row = service.insertRow(plain.id, { ...scope, data: { [note]: 'long text' }, actor: human });

    const updated = service.updateRow(plain.id, row.id, { ...scope, patch: { [note]: 'x' }, actor: human });

    expect(updated.data[note]).toBe('x');
    expect(cols.journal).toBeDefined();
  });
});

describe('row guard (setting off)', () => {
  it('lets a journal be shortened', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: false });
    const row = insert({ [cols.journal]: journalWithTwoLines });

    expect(patch(row.id, { [cols.journal]: 'short' })().data[cols.journal]).toBe('short');
  });

  it('lets a row move to done without a pr_url', () => {
    const { cols, insert, patch } = kanban({ guardEnabled: false });
    const row = insert({ [cols.status]: 'todo' });

    expect(patch(row.id, { [cols.status]: 'done' })().data[cols.status]).toBe('done');
  });
});
