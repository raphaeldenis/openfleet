import { afterEach, describe, expect, it } from 'vitest';
import { CHAIN_CAUSE_WINDOW_MINUTES } from './triggerEngine.js';
import { startPlaybookWorld, type PlaybookWorld } from './playbookWorld.testkit.js';
import { MINUTE_MS } from './triggerWorld.testkit.js';

let playbookWorld: PlaybookWorld | undefined;
afterEach(async () => { await playbookWorld?.close(); playbookWorld = undefined; });

const boot = async () => {
  playbookWorld = await startPlaybookWorld();
  return playbookWorld;
};

const WINDOW_MS = CHAIN_CAUSE_WINDOW_MINUTES * MINUTE_MS;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const isoAhead = (ms: number) => new Date(Date.now() + ms).toISOString();

/** A table, a script that adds a row to it, the approved playbook that runs the script, and a trigger that starts the playbook on each new row of the same table. */
const armTheLoop = async (p: PlaybookWorld) => {
  const table = p.world.createTable(['title']);
  p.writeRowWriterScript('rewrite.sh', { storeId: table.storeId, columnId: table.columns.title! });
  const playbook = await p.createApprovedPlaybook({ program: 'rewrite.sh' });
  const triggerId = await p.armTriggerOnNewRows(table.storeId, playbook.id);
  return { table, playbook, triggerId };
};

/** The state of the loop once the first row has started the first run and that run has ended. */
const loopAfterItsFirstRun = async (p: PlaybookWorld) => {
  const loop = await armTheLoop(p);
  loop.table.insert({ title: 'first row, written by a human' });
  await p.untilRunsStarted(1);
  await p.untilNoRunIsRunning();
  await p.untilFiresLeaveAttempted(loop.triggerId);
  return { ...loop, firstRun: p.runsOf(loop.playbook.id)[0]! };
};

describe('a table written by the script of a run that a trigger started', () => {
  it('is never offered to the trigger that started the run, and the offer leaves one line of the trigger id', async () => {
    const p = await boot();
    const { table, playbook, triggerId } = await armTheLoop(p);

    table.insert({ title: 'first row, written by a human' });
    await p.untilRunsStarted(1);
    await p.untilNoRunIsRunning();
    await p.untilFiresLeaveAttempted(triggerId);

    expect(p.fireRowsOf(triggerId).map((fire) => [fire.ledger_state, fire.chain_depth])).toEqual([['completed', 1]]);
    expect(p.runsOf(playbook.id)).toHaveLength(1);
    expect(p.offersSuppressedFor(triggerId)).toBe(1);
    expect((p.world.db.prepare('SELECT COUNT(*) AS n FROM ds_row_history WHERE store_id = ?').get(table.storeId) as { n: number }).n).toBe(2);
  });

  it('is still not offered to that trigger when the script ended before the write was read, inside the window after the start of the run', async () => {
    const p = await boot();
    const { table, triggerId } = await loopAfterItsFirstRun(p);
    const suppressedBefore = p.offersSuppressedFor(triggerId);

    table.insert({ title: 'a later row' });

    expect(p.offersSuppressedFor(triggerId)).toBe(suppressedBefore + 1);
    expect(p.fireRowsOf(triggerId)).toHaveLength(1);
  });

  it('is offered again once the window after the start of an ended run has passed', async () => {
    const p = await boot();
    const { table, triggerId, firstRun } = await loopAfterItsFirstRun(p);
    p.dateRun(firstRun.id, { startedAt: isoAgo(WINDOW_MS + 10 * MINUTE_MS), endedAt: isoAgo(WINDOW_MS + 9 * MINUTE_MS) });

    table.insert({ title: 'a row after the window' });

    expect(p.fireRowsOf(triggerId).map((fire) => fire.chain_depth)).toEqual([1, 1]);
  });

  it('is not offered to the trigger while its run is still running, however long ago the run started', async () => {
    const p = await boot();
    const { table, triggerId, firstRun } = await loopAfterItsFirstRun(p);
    p.dateRun(firstRun.id, { startedAt: isoAgo(3 * WINDOW_MS), endedAt: null, status: 'running' });
    const suppressedBefore = p.offersSuppressedFor(triggerId);

    table.insert({ title: 'a row during a long run' });

    expect(p.offersSuppressedFor(triggerId)).toBe(suppressedBefore + 1);
    expect(p.fireRowsOf(triggerId)).toHaveLength(1);
  });

  it('is not offered to the trigger when the run ended after the write, even if it started before the window', async () => {
    const p = await boot();
    const { table, triggerId, firstRun } = await loopAfterItsFirstRun(p);
    p.dateRun(firstRun.id, { startedAt: isoAgo(3 * WINDOW_MS), endedAt: isoAhead(MINUTE_MS) });
    const suppressedBefore = p.offersSuppressedFor(triggerId);

    table.insert({ title: 'a row before the end of the run' });

    expect(p.offersSuppressedFor(triggerId)).toBe(suppressedBefore + 1);
  });

  it('is not caused by a run that starts after the write', async () => {
    const p = await boot();
    const { table, triggerId, firstRun } = await loopAfterItsFirstRun(p);
    p.dateRun(firstRun.id, { startedAt: isoAhead(10 * MINUTE_MS), endedAt: isoAhead(11 * MINUTE_MS) });

    table.insert({ title: 'a row before the run' });

    expect(p.fireRowsOf(triggerId).map((fire) => fire.chain_depth)).toEqual([1, 1]);
  });

  it('is not caused by the run of a trigger of another project', async () => {
    const p = await boot();
    const { world } = p;
    world.db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('project-elsewhere', 'Elsewhere', 'now')").run();
    p.writeScript('quick.sh', 'printf done');
    const foreign = await p.createApprovedPlaybook({ program: 'quick.sh', projectId: 'project-elsewhere' });
    const created = await world.json<{ id: string; contentRev: number }>(await world.api('/api/triggers', {
      method: 'POST', body: JSON.stringify({ projectId: 'project-elsewhere', ownerManagerId: null, title: 'elsewhere', run: { kind: 'run_playbook', playbookId: foreign.id } }),
    }));
    await world.api(`/api/triggers/${created.id}/arm`, { method: 'POST', body: JSON.stringify({ approvedRev: created.contentRev }), headers: { 'x-human-proof': 'proof' } });
    world.engine.submit({ triggerId: created.id, dedupKey: 'elsewhere', event: { session: { id: 's1' } } });
    await p.untilRunsStarted(1);
    await p.untilNoRunIsRunning();
    const { table, triggerId } = await armTheLoop(p);

    table.insert({ title: 'a human row while another project runs a playbook' });

    expect(p.fireRowsOf(triggerId).map((fire) => [fire.ledger_state, fire.chain_depth])).toEqual([['attempted', 1]]);
    expect(p.offersSuppressedFor(triggerId)).toBe(0);
    await p.untilRunsStarted(2);
    await p.untilNoRunIsRunning();
  });
});

describe('a chain of triggers whose playbooks write each other\'s tables', () => {
  const armTwoTriggersThatFeedEachOther = async (p: PlaybookWorld) => {
    const tableX = p.world.createTable(['x']);
    const tableY = p.world.createTable(['y']);
    p.writeRowWriterScript('x-to-y.sh', { storeId: tableY.storeId, columnId: tableY.columns.y! });
    p.writeRowWriterScript('y-to-x.sh', { storeId: tableX.storeId, columnId: tableX.columns.x! });
    const playbookA = await p.createApprovedPlaybook({ program: 'x-to-y.sh' });
    const playbookB = await p.createApprovedPlaybook({ program: 'y-to-x.sh' });
    const triggerA = await p.armTriggerOnNewRows(tableX.storeId, playbookA.id);
    const triggerB = await p.armTriggerOnNewRows(tableY.storeId, playbookB.id);
    return { tableX, playbookA, playbookB, triggerA, triggerB };
  };

  it('runs A once and B once, one step deeper, and cuts the way back to A', async () => {
    const p = await boot();
    const { tableX, playbookA, playbookB, triggerA, triggerB } = await armTwoTriggersThatFeedEachOther(p);

    tableX.insert({ x: 'a human row' });
    await p.untilRunsStarted(2);
    await p.untilNoRunIsRunning();
    await p.untilFiresLeaveAttempted(triggerA);
    await p.untilFiresLeaveAttempted(triggerB);

    expect(p.fireRowsOf(triggerA).map((fire) => [fire.ledger_state, fire.chain_depth])).toEqual([['completed', 1]]);
    expect(p.fireRowsOf(triggerB).map((fire) => [fire.ledger_state, fire.chain_depth])).toEqual([['completed', 2]]);
    expect([p.runsOf(playbookA.id).length, p.runsOf(playbookB.id).length]).toEqual([1, 1]);
    expect(p.offersSuppressedFor(triggerA)).toBe(1);
  });

  it('cancels the third link of a chain with chain_depth and starts no run for it', async () => {
    const p = await boot();
    const tableX = p.world.createTable(['x']);
    const tableY = p.world.createTable(['y']);
    const tableZ = p.world.createTable(['z']);
    p.writeRowWriterScript('x-to-y.sh', { storeId: tableY.storeId, columnId: tableY.columns.y! });
    p.writeRowWriterScript('y-to-z.sh', { storeId: tableZ.storeId, columnId: tableZ.columns.z! });
    p.writeScript('end.sh', 'printf end');
    const playbookA = await p.createApprovedPlaybook({ program: 'x-to-y.sh' });
    const playbookB = await p.createApprovedPlaybook({ program: 'y-to-z.sh' });
    const playbookC = await p.createApprovedPlaybook({ program: 'end.sh' });
    const triggerA = await p.armTriggerOnNewRows(tableX.storeId, playbookA.id);
    const triggerB = await p.armTriggerOnNewRows(tableY.storeId, playbookB.id);
    const triggerC = await p.armTriggerOnNewRows(tableZ.storeId, playbookC.id);

    tableX.insert({ x: 'a human row' });
    await p.untilRunsStarted(2);
    await p.untilNoRunIsRunning();
    await p.untilFiresLeaveAttempted(triggerB);

    expect(p.fireRowsOf(triggerA).map((fire) => fire.chain_depth)).toEqual([1]);
    expect(p.fireRowsOf(triggerB).map((fire) => fire.chain_depth)).toEqual([2]);
    expect(p.fireRowsOf(triggerC).map((fire) => [fire.ledger_state, fire.settle_reason, fire.chain_depth, fire.run_id])).toEqual([['cancelled', 'chain_depth', 3, null]]);
    expect(p.runsOf(playbookC.id)).toEqual([]);
  });
});

describe('the run of a fire is found from the fire', () => {
  it('links the fire to the run it started, so that the chain depth of the run is the depth of its fire', async () => {
    const p = await boot();
    const { triggerId, firstRun } = await loopAfterItsFirstRun(p);

    expect(p.fireRowsOf(triggerId)).toEqual([{ ledger_state: 'completed', settle_reason: null, chain_depth: 1, run_id: firstRun.id }]);
  });
});
