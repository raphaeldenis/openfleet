import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTableToolsKit, type TableToolsKit } from './tableTools.testkit.js';

let kit: TableToolsKit;

const BACKLOG_NAME = 'Manager backlog';
const insertTicket = () => kit.call('insert_data_store_rows', { store: BACKLOG_NAME, rows: [{ Ticket: 'T-1' }] });

beforeEach(async () => {
  kit = await startTableToolsKit();
  const store = kit.stores.createStore({ projectId: 'p1', displayName: BACKLOG_NAME });
  kit.stores.addColumn(store.id, { projectId: 'p1', displayName: 'Ticket', columnType: 'text' });
});
afterEach(async () => {
  await kit.close();
});

describe('insert_data_store_rows on the backlog of a project whose repository is shared', () => {
  it('answers backlog_write_refused to a session that is not a manager', async () => {
    kit.db.prepare('UPDATE projects SET shared_repo = 1 WHERE id = ?').run('p1');

    const outcome = await insertTicket();

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('backlog_write_refused');
  });

  it('inserts for a manager session', async () => {
    kit.db.prepare('UPDATE projects SET shared_repo = 1 WHERE id = ?').run('p1');
    kit.db.prepare("UPDATE sessions SET role = 'manager'").run();

    const outcome = await insertTicket();

    expect(outcome.isError).toBe(false);
    expect(outcome.json.inserted).toBe(1);
  });

  it('inserts for any session while the repository is not shared', async () => {
    const outcome = await insertTicket();

    expect(outcome.json.inserted).toBe(1);
  });
});
