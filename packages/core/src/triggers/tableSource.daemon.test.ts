import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_OFFERS_PER_RUN, MAX_PAGES_PER_RUN } from './tableSource.js';
import { TriggerEngine } from './triggerEngine.js';
import { MINUTE_MS, PROJECT_ID, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

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

/** The manager writes a row through the MCP tool of the daemon, as an agent does after a trigger prompted it. */
const writeThroughMcp = async (writer: Awaited<ReturnType<TriggerWorld['connect']>>, table: ReturnType<TriggerWorld['createTable']>, status: string) => {
  const result = await writer.callTool({ name: 'insert_data_store_rows', arguments: { store: table.storeId, rows: [{ [table.columns.status!]: status }] } });
  expect(result.isError ?? false).toBe(false);
};
const suppressedOffersOf = (triggerId: string) =>
  (world!.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'trigger.offer_suppressed' AND entity_id = ?").get(triggerId) as { n: number }).n;
const chainDepthsOf = (triggerId: string) =>
  (world!.db.prepare('SELECT chain_depth FROM trigger_fires WHERE trigger_id = ? ORDER BY fired_at, rowid').all(triggerId) as { chain_depth: number }[]).map((row) => row.chain_depth);

describe('the causal loop guard', () => {
  it('does not offer to a trigger the rows its own message made the manager write', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });
    const leadClient = await world.connect(lead.id);

    table.insert({ status: 'by a human' });
    await writeThroughMcp(leadClient, table, 'written by the manager after the prompt');

    expect(statesOf(triggerId)).toEqual(['completed']);
    expect(suppressedOffersOf(triggerId)).toBe(1);
  });

  it('attributes the write of a child to the trigger that prompted its manager', async () => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead, 'Worker');
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });
    const childClient = await world.connect(child.id);

    table.insert({ status: 'by a human' });
    await writeThroughMcp(childClient, table, 'written by the child');

    expect(statesOf(triggerId)).toEqual(['completed']);
  });

  it('considers every session of the name of the author: two managers called alike', async () => {
    const { world, lead } = await worldWithLead();
    const twin = await world.createSession('Lead', { manager: world.managerSpec });
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: twin.id, when: { event: 'new_matching_rows' } });
    const leadClient = await world.connect(lead.id);

    table.insert({ status: 'by a human' });
    await writeThroughMcp(leadClient, table, 'written by the namesake');

    expect(statesOf(triggerId)).toEqual(['completed']);
  });

  it('never attributes the write of a human to a trigger, even under the label of a session that was prompted', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });

    table.insert({ status: 'first' });
    table.insert({ status: 'second, by a human who signs as the manager' }, { kind: 'human', label: `${lead.emoji} ${lead.name}` });

    expect(statesOf(triggerId)).toEqual(['completed', 'completed']);
    expect(suppressedOffersOf(triggerId)).toBe(0);
  });

  it('stops a loop through two tables: the trigger that prompted the manager is not offered the rows it made the manager write', async () => {
    const { world, lead } = await worldWithLead();
    const first = world.createTable(['status']);
    const second = world.createTable(['status', 'extra']);
    const triggerA = await armTableTrigger({ storeId: first.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });
    const triggerB = await armTableTrigger({ storeId: second.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });
    const leadClient = await world.connect(lead.id);

    first.insert({ status: 'start' });
    await writeThroughMcp(leadClient, second, 'A made me write this');
    await writeThroughMcp(leadClient, first, 'B made me write this');

    expect(statesOf(triggerA)).toEqual(['completed']);
    expect(statesOf(triggerB)).toEqual(['completed']);
    expect(chainDepthsOf(triggerB)).toEqual([2]);
  });

  it('cancels at the depth cap a fire that is the third link of a chain of triggers', async () => {
    const { world, lead } = await worldWithLead();
    const tables = [world.createTable(['status', 'first']), world.createTable(['status', 'second']), world.createTable(['status', 'third'])] as const;
    const [triggerA, triggerB, triggerC] = [
      await armTableTrigger({ storeId: tables[0].storeId, managerId: lead.id, when: { event: 'new_matching_rows' } }),
      await armTableTrigger({ storeId: tables[1].storeId, managerId: lead.id, when: { event: 'new_matching_rows' } }),
      await armTableTrigger({ storeId: tables[2].storeId, managerId: lead.id, when: { event: 'new_matching_rows' } }),
    ];
    const leadClient = await world.connect(lead.id);

    tables[0].insert({ status: 'start' });
    await writeThroughMcp(leadClient, tables[1], 'second link');
    await writeThroughMcp(leadClient, tables[2], 'third link');

    expect(statesOf(triggerA)).toEqual(['completed']);
    expect(statesOf(triggerB)).toEqual(['completed']);
    expect(world.firesOf(triggerC)).toEqual([expect.objectContaining({ ledger_state: 'cancelled', settle_reason: 'chain_depth' })]);
    expect(chainDepthsOf(triggerC)).toEqual([3]);
  });
});

describe('the attribution of a write to the message that set its author going', () => {
  it('holds when the event is old and the message goes out much later: an event of three hours ago, sent at boot, still causes the write that follows', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * MINUTE_MS).toISOString();

    await world.restart({
      whileStopped: (db) => {
        db.prepare("INSERT INTO ds_rows (id, store_id, data_json, created_at, updated_at) VALUES ('old-row', ?, '{}', ?, ?)").run(table.storeId, threeHoursAgo, threeHoursAgo);
        db.prepare("INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES ('old-change', ?, 'old-row', 'human', 'world', '{\"kind\":\"create\"}', ?)").run(table.storeId, threeHoursAgo);
      },
    });
    const leadClient = await world.connect(lead.id);
    await writeThroughMcp(leadClient, table, 'written by the manager after the late prompt');

    expect(statesOf(triggerId)).toEqual(['completed']);
    expect(suppressedOffersOf(triggerId)).toBe(1);
  });

  it('holds when a cooldown kept the fire back and the message went out afterwards', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({
      storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' }, policy: { cooldownSeconds: 600, batchMode: 'per_batch' },
    });
    const leadClient = await world.connect(lead.id);

    table.insert({ status: 'first' });
    table.insert({ status: 'held by the cooldown' });
    world.advanceMs(11 * MINUTE_MS);
    world.fireLivingTimers();
    await writeThroughMcp(leadClient, table, 'written after the late prompt');

    expect(world.firesOf(triggerId).filter((fire) => fire.ledger_state === 'completed')).toHaveLength(2);
    expect(suppressedOffersOf(triggerId)).toBe(1);
  });

  it('ignores a session of the same name in another project: it causes nothing', async () => {
    const { world, lead } = await worldWithLead();
    world.db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('other', 'Other', 'now')").run();
    const otherStore = world.daemon.stores.createStore({ projectId: 'other', displayName: 'Other table' });
    const namesake = await world.createSession('Lead', { manager: world.managerSpec });
    world.db.prepare("UPDATE sessions SET project_id = 'other' WHERE id = ?").run(namesake.id);
    const created = await world.json<{ id: string; contentRev: number }>(await world.api('/api/triggers', {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'other', ownerManagerId: null, title: 'other', when: { source: 'data_store_query', storeId: otherStore.id, event: 'new_matching_rows' },
        conditions: [], run: { kind: 'prompt_manager', managerId: namesake.id, prompt: 'other table changed' },
      }),
    }));
    await world.api(`/api/triggers/${created.id}/arm`, { method: 'POST', body: JSON.stringify({ approvedRev: created.contentRev }), headers: { 'x-human-proof': 'proof' } });
    world.daemon.stores.insertRow(otherStore.id, { projectId: 'other', actor: { kind: 'human', label: 'world' }, data: {} });
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });
    const leadClient = await world.connect(lead.id);

    await writeThroughMcp(leadClient, table, 'written by the manager of this project');

    expect(world.messagesTo(namesake.id).filter((message) => message.body.startsWith('trigger.fired'))).toHaveLength(1);
    expect(chainDepthsOf(triggerId)).toEqual([1]);
  });
});

describe('a backlog that crashes between the offers and the cursor', () => {
  const writeWhileStopped = (storeId: string, db: import('node:sqlite').DatabaseSync, id: string, at: string) => {
    db.prepare("INSERT INTO ds_rows (id, store_id, data_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)").run(id, storeId, at, at);
    db.prepare("INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES (?, ?, ?, 'human', 'world', '{\"kind\":\"create\"}', ?)").run(`change-${id}`, storeId, id, at);
  };

  it('loses no offer and fires none twice when the second instance starts', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });
    const crashOnTheFirstBacklog = vi.spyOn(TriggerEngine.prototype, 'submitBacklog').mockImplementationOnce(() => { throw new Error('the daemon stopped here'); });

    await world.restart({ whileStopped: (db) => writeWhileStopped(table.storeId, db, 'late-row', new Date(world.nowMs).toISOString()) });
    const firesAfterTheCrash = world.firesOf(triggerId).length;
    const cursorAfterTheCrash = world.cursorOf(triggerId)?.seq;
    await world.restart();
    crashOnTheFirstBacklog.mockRestore();

    expect(firesAfterTheCrash).toBe(0);
    expect(cursorAfterTheCrash).toBeLessThan(world.cursorOf(triggerId)?.seq ?? 0);
    expect(statesOf(triggerId)).toEqual(['completed']);
    expect(bodiesTo(lead.id)).toHaveLength(1);
  });
});

describe('a long history written while the daemon was stopped', () => {
  const writeManyWhileStopped = (storeId: string, db: import('node:sqlite').DatabaseSync, count: number, at = new Date().toISOString()) => {
    const insertRow = db.prepare("INSERT INTO ds_rows (id, store_id, data_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)");
    const insertChange = db.prepare("INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES (?, ?, ?, 'human', 'world', '{\"kind\":\"create\"}', ?)");
    db.exec('BEGIN');
    for (let index = 0; index < count; index += 1) {
      insertRow.run(`bulk-${index}`, storeId, at, at);
      insertChange.run(`bulk-change-${index}`, storeId, `bulk-${index}`, at);
    }
    db.exec('COMMIT');
  };

  it('is read within a budget per run and finished on the next ticks, offering the latest change only once per run with fire_latest_only', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const changes = 5000;
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' }, policy: { backlogPolicy: 'fire_latest_only' } });
    const latestSeq = () => (world.db.prepare('SELECT MAX(seq) AS seq FROM ds_row_history').get() as { seq: number }).seq;

    await world.restart({ whileStopped: (db) => writeManyWhileStopped(table.storeId, db, changes) });
    const cursorAfterBoot = world.cursorOf(triggerId)?.seq ?? 0;
    const firesAfterBoot = world.firesOf(triggerId).length;
    for (let tick = 0; tick < 10 && (world.cursorOf(triggerId)?.seq ?? 0) < latestSeq(); tick += 1) world.fireLivingTimers();

    expect(cursorAfterBoot).toBeLessThan(latestSeq());
    expect(firesAfterBoot).toBe(1);
    expect(world.cursorOf(triggerId)?.seq).toBe(latestSeq());
    expect(world.firesOf(triggerId)).toHaveLength(Math.ceil(changes / (MAX_PAGES_PER_RUN * 200)));
  });

  it('keeps the policy of the catch-up when a live write arrives before the next tick: no burst of single offers, the breaker stays shut', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' }, policy: { backlogPolicy: 'fire_latest_only' } });
    const changes = MAX_PAGES_PER_RUN * 200 + 500;
    const latestSeq = () => (world.db.prepare('SELECT MAX(seq) AS seq FROM ds_row_history').get() as { seq: number }).seq;

    await world.restart({ whileStopped: (db) => writeManyWhileStopped(table.storeId, db, changes) });
    const firesAfterBoot = world.firesOf(triggerId).length;
    world.daemon.stores.insertRow(table.storeId, { projectId: PROJECT_ID, actor: { kind: 'human', label: 'world' }, data: {} });
    const firesAfterTheLiveWrite = world.firesOf(triggerId).length;
    for (let tick = 0; tick < 10 && (world.cursorOf(triggerId)?.seq ?? 0) < latestSeq(); tick += 1) world.fireLivingTimers();

    expect(firesAfterBoot).toBe(1);
    expect(firesAfterTheLiveWrite).toBe(firesAfterBoot);
    expect(world.cursorOf(triggerId)?.seq).toBe(latestSeq());
    expect(world.firesOf(triggerId).filter((fire) => fire.settle_reason === 'breaker_open')).toEqual([]);
    expect((world.db.prepare('SELECT armed_at FROM triggers WHERE id = ?').get(triggerId) as { armed_at: string | null }).armed_at).not.toBeNull();
    expect(world.firesOf(triggerId).length).toBeLessThanOrEqual(3);
  });

  it('offers exactly the budget of offers in a run: 1000 changes make 500 fires per run', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' }, policy: { backlogPolicy: 'discard_stale' } });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * MINUTE_MS).toISOString();

    await world.restart({ whileStopped: (db) => writeManyWhileStopped(table.storeId, db, 1000, threeHoursAgo) });
    const firesAfterBoot = world.firesOf(triggerId).length;
    world.fireLivingTimers();

    expect(firesAfterBoot).toBe(MAX_OFFERS_PER_RUN);
    expect(world.firesOf(triggerId)).toHaveLength(1000);
  });

  it('counts, and does not offer, a change whose event is too large', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: { event: 'new_matching_rows' } });

    table.insert({ status: 'x'.repeat(9000) });
    table.insert({ status: 'small' });

    expect(statesOf(triggerId)).toEqual(['completed']);
    expect(world.cursorOf(triggerId)?.tooLarge).toBe(1);
  });
});

describe('row_count read from the journal', () => {
  const countFires = { event: 'row_count', op: 'gte', value: 1 } as const;
  const createdAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  const journal = (storeId: string, db: import('node:sqlite').DatabaseSync, steps: { kind: 'create' | 'delete'; id: string; at?: string }[]) => {
    for (const step of steps) {
      const at = step.at ?? createdAt(0);
      if (step.kind === 'create') db.prepare("INSERT INTO ds_rows (id, store_id, data_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)").run(step.id, storeId, at, at);
      else db.prepare('DELETE FROM ds_rows WHERE id = ?').run(step.id);
      db.prepare('INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(`${step.kind}-${step.id}`, storeId, step.id, 'human', 'world', JSON.stringify({ kind: step.kind }), at);
    }
  };

  it('fires for a threshold crossed and left again while the daemon was stopped', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: countFires });

    await world.restart({ whileStopped: (db) => journal(table.storeId, db, [{ kind: 'create', id: 'a' }, { kind: 'delete', id: 'a' }]) });

    expect(statesOf(triggerId)).toEqual(['completed']);
  });

  it('offers one fire per crossing, each dated by the change that crossed: 1, 2, 1, 0, 1 gives two with fire_all', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: countFires });

    await world.restart({
      whileStopped: (db) => journal(table.storeId, db, [
        { kind: 'create', id: 'a' }, { kind: 'create', id: 'b' }, { kind: 'delete', id: 'b' }, { kind: 'delete', id: 'a' }, { kind: 'create', id: 'c' },
      ]),
    });

    expect(statesOf(triggerId)).toEqual(['completed', 'completed']);
    expect(world.db.prepare('SELECT dedup_key FROM trigger_fires WHERE trigger_id = ?').all(triggerId)).toHaveLength(2);
  });

  it('judges an old crossing by its own date with discard_stale, even when a recent update follows it', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, managerId: lead.id, when: countFires, policy: { backlogPolicy: 'discard_stale' } });
    const threeHoursAgo = createdAt(-3 * 60 * MINUTE_MS);

    await world.restart({
      whileStopped: (db) => {
        journal(table.storeId, db, [{ kind: 'create', id: 'old', at: threeHoursAgo }]);
        db.prepare("INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES ('recent-update', ?, 'old', 'human', 'world', '{\"col\":{\"from\":1,\"to\":2}}', ?)")
          .run(table.storeId, createdAt(0));
      },
    });

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'cancelled', settle_reason: 'stale' })]);
  });
});

describe('an owner that is no longer a manager', () => {
  it('cancels the fire as not eligible, even though the RUN names a manager', async () => {
    const { world, lead } = await worldWithLead();
    const table = world.createTable(['status']);
    const triggerId = await armTableTrigger({ storeId: table.storeId, ownerManagerId: lead.id, managerId: lead.id, when: { event: 'new_matching_rows' } });
    world.db.prepare('DELETE FROM managers WHERE session_id = ?').run(lead.id);

    table.insert({ status: 'a' });

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'cancelled', settle_reason: 'target_not_eligible' })]);
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
