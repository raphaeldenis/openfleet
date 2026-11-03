import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_ID, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

let world: TriggerWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const worldWithLead = async () => {
  world = await startTriggerWorld();
  const lead = await world.createSession('Lead', { manager: world.managerSpec });
  return { world, lead };
};
/** What the triggers sent: the manager also receives the lines the daemon writes on its own. */
const bodiesTo = (sessionId: string) => world!.messagesTo(sessionId).map((message) => message.body).filter((body) => body.startsWith('trigger.fired'));
const statesOf = (triggerId: string) => world!.firesOf(triggerId).map((fire) => fire.ledger_state);

const armTableTrigger = (input: { storeId: string; managerId?: string; ownerManagerId?: string | null; when: Record<string, unknown>; conditions?: unknown[]; policy?: unknown }) =>
  world!.createArmedTrigger({
    title: 'table', when: { source: 'data_store_query', storeId: input.storeId, ...input.when }, conditions: input.conditions ?? [],
    run: { kind: 'prompt_manager', ...(input.managerId === undefined ? {} : { managerId: input.managerId }), prompt: 'a table changed' },
    ownerManagerId: input.ownerManagerId ?? null, ...(input.policy === undefined ? {} : { policy: input.policy }),
  });

describe('new_matching_rows', () => {
  it('fires once for each new row that satisfies the conditions, and for no other row', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({
      storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' },
      conditions: [{ lhs: `event.row.${table.columns.status}`, op: 'eq', rhs: 'down' }],
    });

    table.insert({ status: 'down' });
    table.insert({ status: 'up' });
    table.insert({ status: 'down' });

    expect(statesOf(triggerId)).toEqual(['completed', 'completed']);
    expect(bodiesTo(lead.id)).toHaveLength(2);
  });

  it('ignores the rows that exist before the trigger is armed', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    table.insert({ status: 'down' });
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });
    const afterArming = world.firesOf(triggerId).length;

    table.insert({ status: 'after arming' });

    expect(afterArming).toBe(0);
    expect(statesOf(triggerId)).toEqual(['completed']);
  });

  it('does not put the text of a row in the message nor in the activity log', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });

    table.insert({ status: 'SECRET-ROW-TEXT' });

    expect(bodiesTo(lead.id).join('\n')).not.toContain('SECRET-ROW-TEXT');
    const activity = world.db.prepare('SELECT * FROM activity_log').all();
    expect(JSON.stringify(activity)).not.toContain('SECRET-ROW-TEXT');
  });

  it('stays inside the project: a store of another project never fires the trigger', async () => {
    const { world, lead } = await worldWithLead();
    world.db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('other', 'Other', 'now')").run();
    world.db.prepare("INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES ('foreign', 'other', 'Foreign', 'now', 'now')").run();
    const triggerId = await armTableTrigger({ storeId: 'foreign', managerId: lead.id, when: { event: 'new_matching_rows' } });

    world.daemon.stores.insertRow('foreign', { projectId: 'other', actor: { kind: 'human', label: 'world' }, data: {} });

    expect(world.firesOf(triggerId)).toEqual([]);
  });
});

describe('row_updated', () => {
  const armStatusWentDown = (table: ReturnType<TriggerWorld['createTable']>, managerId: string) => armTableTrigger({
    storeId: table.storeId, managerId, when: { event: 'row_updated' },
    conditions: [
      { lhs: `event.previous.${table.columns.status}`, op: 'eq', rhs: 'up' },
      { lhs: `event.row.${table.columns.status}`, op: 'eq', rhs: 'down' },
    ],
  });

  it('fires once when up goes to down, not when down stays down, nor when another column changes', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status', 'owner']);
    const row = table.insert({ status: 'up', owner: 'a' });
    const triggerId = await armStatusWentDown(table, lead.id);

    table.update(row.id, { status: 'down' });
    table.update(row.id, { status: 'down' });
    table.update(row.id, { owner: 'b' });

    expect(statesOf(triggerId)).toEqual(['completed']);
  });

  it('does not fire for the creation of a row', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'row_updated' } });

    table.insert({ status: 'down' });

    expect(world.firesOf(triggerId)).toEqual([]);
  });
});

describe('row_count', () => {
  it('fires when the count crosses the threshold, once, and again after it fell back below', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'row_count', op: 'gt', value: 2 } });

    table.insert({ status: 'a' });
    table.insert({ status: 'b' });
    const third = table.insert({ status: 'c' });
    const afterCrossing = statesOf(triggerId);
    table.insert({ status: 'd' });
    const whileStillAbove = statesOf(triggerId);
    table.remove(third.id);
    const remainingRows = world.db.prepare('SELECT id FROM ds_rows WHERE store_id = ? ORDER BY created_at, rowid').all(table.storeId) as { id: string }[];
    for (const row of remainingRows.slice(1)) table.remove(row.id);
    table.insert({ status: 'e' });
    table.insert({ status: 'f' });

    expect(afterCrossing).toEqual(['completed']);
    expect(whileStillAbove).toEqual(['completed']);
    expect(statesOf(triggerId)).toEqual(['completed', 'completed']);
  });

  it('does not fire at arming time when the count already satisfies the threshold', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    table.insert({ status: 'a' });
    table.insert({ status: 'b' });
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'row_count', op: 'gte', value: 1 } });

    expect(world.firesOf(triggerId)).toEqual([]);
  });
});

describe('the loop guard', () => {
  it('ignores the rows written by the trigger itself, and still reacts to those written by another trigger', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });

    table.insert({ status: 'by me' }, { kind: 'trigger', label: triggerId });
    const afterOwnWrite = world.firesOf(triggerId).length;
    table.insert({ status: 'by another' }, { kind: 'trigger', label: 'another-trigger' });

    expect(afterOwnWrite).toBe(0);
    expect(statesOf(triggerId)).toEqual(['completed']);
  });

  it('does not let a crossing of the count caused only by its own writes fire the trigger', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'row_count', op: 'gte', value: 1 } });

    table.insert({ status: 'by me' }, { kind: 'trigger', label: triggerId });

    expect(world.firesOf(triggerId)).toEqual([]);
  });
});

describe('the cursor', () => {
  it('is kept per trigger in trigger_cursors and never goes back', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });

    table.insert({ status: 'a' });
    const afterFirst = world.cursorOf(triggerId)?.seq ?? 0;
    table.insert({ status: 'b' });
    const afterSecond = world.cursorOf(triggerId)?.seq ?? 0;
    await world.api(`/api/triggers/${triggerId}/disarm`, { method: 'POST', body: '{}' });
    const afterDisarm = world.cursorOf(triggerId)?.seq ?? 0;

    expect(world.cursorOf(triggerId)?.kind).toBe('table');
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBeGreaterThan(afterFirst);
    expect(afterDisarm).toBeGreaterThanOrEqual(afterSecond);
  });

  it('offers after a restart the rows written while the daemon was stopped, once, and never again at the next restart', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });
    table.insert({ status: 'before the stop' });
    const writeWhileStopped = (db: import('node:sqlite').DatabaseSync) => {
      db.prepare("INSERT INTO ds_rows (id, store_id, data_json, created_at, updated_at) VALUES ('late-row', ?, '{}', 'now', 'now')").run(table.storeId);
      db.prepare("INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES ('late-change', ?, 'late-row', 'human', 'world', '{\"kind\":\"create\"}', ?)")
        .run(table.storeId, new Date(world.nowMs).toISOString());
    };

    await world.restart({ whileStopped: writeWhileStopped });
    const afterFirstRestart = statesOf(triggerId);
    await world.restart();

    expect(afterFirstRestart).toEqual(['completed', 'completed']);
    expect(statesOf(triggerId)).toEqual(['completed', 'completed']);
  });

  it('replays nothing twice when the cursor is behind the ledger: the dedup key keeps one fire per change', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });
    table.insert({ status: 'a' });
    table.insert({ status: 'b' });
    const rewindCursor = (db: import('node:sqlite').DatabaseSync) => void db.prepare("UPDATE trigger_cursors SET cursor_json = json_set(cursor_json, '$.seq', 0)").run();

    await world.restart({ whileStopped: rewindCursor });

    expect(statesOf(triggerId)).toEqual(['completed', 'completed']);
    expect(bodiesTo(lead.id)).toHaveLength(2);
  });

  it('is not taken away by the session_state source when the daemon starts', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });
    table.insert({ status: 'a' });
    const cursorBefore = world.cursorOf(triggerId);

    await world.restart();

    expect(world.cursorOf(triggerId)).toEqual(cursorBefore);
  });
});

describe('the owner', () => {
  it('prompts the owner manager when the RUN names no manager', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    await armTableTrigger({ storeId: table.storeId, ownerManagerId: lead.id, when: { event: 'new_matching_rows' } });

    table.insert({ status: 'a' });

    expect(bodiesTo(lead.id)).toHaveLength(1);
  });

  it('cancels the fire, and sends nothing, when the RUN names a manager of another lineage', async () => {
    const { world, lead } = await worldWithLead();
    const otherLead = await world.createSession('Other lead', { manager: world.managerSpec });
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, ownerManagerId: lead.id, managerId: otherLead.id, when: { event: 'new_matching_rows' } });

    table.insert({ status: 'a' });

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'cancelled', settle_reason: 'target_not_eligible' })]);
    expect(bodiesTo(otherLead.id)).toEqual([]);
  });

  it('prompts nothing for a trigger with neither owner nor named manager', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, when: { event: 'new_matching_rows' } });

    table.insert({ status: 'a' });

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'cancelled', settle_reason: 'target_unavailable' })]);
    expect(bodiesTo(lead.id)).toEqual([]);
  });
});
