import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MAX_PENDING_PROPOSALS_PER_MANAGER, MAX_QUEUED_PROPOSALS_PER_MANAGER } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, OWN_PROJECT_ID, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';

let fixture: GovernanceFixture;
let lead: Client;
let worker: Client;
let siblingLead: Client;
beforeEach(async () => {
  fixture = await startGovernanceFixture();
  [lead, worker, siblingLead] = await Promise.all([fixture.connect(fixture.lead.id), fixture.connect(fixture.worker.id), fixture.connect(fixture.siblingLead.id)]);
});
afterEach(async () => { await fixture.close(); });

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const isError = (result: unknown): boolean => (result as { isError?: boolean }).isError === true;
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const jsonOf = (result: unknown) => JSON.parse(textOf(result)) as Record<string, any>;

const bootstrap = async (client: Client = lead, args: Record<string, unknown> = {}) => jsonOf(await call(client, 'bootstrap_project_profile', args));
const managerCardOf = async (client: Client = lead) => jsonOf(await call(client, 'get_argus_status')).manager as Record<string, any>;
const governanceOf = async (client: Client = lead) => jsonOf(await call(client, 'get_argus_governance'));
const storesOf = async (client: Client = lead) => (jsonOf(await call(client, 'describe_data_store')).stores as { id: string; displayName: string }[]);
const noteCount = () => (fixture.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE project_id = ?').get(OWN_PROJECT_ID) as { n: number }).n;
const filedRequestsOf = (governance: Record<string, any>) => [...governance.pending, ...governance.queued];

describe('bootstrap_project_profile on a project with no table and no note', () => {
  it('creates the journal and backlog tables of the project', async () => {
    await bootstrap();

    const tableNames = (await storesOf()).map((store) => store.displayName).sort();

    expect(tableNames).toEqual(['Manager backlog', 'Manager journal']);
  });

  it('links a new mission note and binds the journal table as the log table of the manager', async () => {
    const report = await bootstrap();

    const card = await managerCardOf();
    const journal = (await storesOf()).find((store) => store.displayName === 'Manager journal')!;

    expect(card.missionNoteId).toBe(report.missionNote.id);
    expect(card.logStoreId).toBe(journal.id);
    expect(noteCount()).toBe(1);
  });

  it('files one access request per table and grants nothing', async () => {
    await bootstrap();

    const governance = await governanceOf();
    const tableIds = (await storesOf()).map((store) => store.id).sort();

    expect(governance.resourceGrants).toEqual([]);
    expect(filedRequestsOf(governance)).toHaveLength(2);
    expect(filedRequestsOf(governance).map((request) => request.resourceId).sort()).toEqual(tableIds);
  });

  it('reports every item it made as created', async () => {
    const report = await bootstrap();

    expect(report.tables.map((table: { created: boolean }) => table.created)).toEqual([true, true]);
    expect(report.missionNote.created).toBe(true);
  });
});

describe('bootstrap_project_profile run twice', () => {
  it('changes nothing on the second call and answers with the same identifiers', async () => {
    const first = await bootstrap();
    const cardAfterFirst = await managerCardOf();
    const governanceAfterFirst = await governanceOf();

    const second = await bootstrap();

    expect(second.missionNote.id).toBe(first.missionNote.id);
    expect(second.tables.map((table: { id: string }) => table.id)).toEqual(first.tables.map((table: { id: string }) => table.id));
    expect(second.grantRequests.map((request: { requestId: string }) => request.requestId)).toEqual(first.grantRequests.map((request: { requestId: string }) => request.requestId));
    expect(await managerCardOf()).toEqual(cardAfterFirst);
    expect(await storesOf()).toHaveLength(2);
    expect(noteCount()).toBe(1);
    expect(filedRequestsOf(await governanceOf())).toEqual(filedRequestsOf(governanceAfterFirst));
  });

  it('reports nothing as created on the second call', async () => {
    await bootstrap();

    const second = await bootstrap();

    expect(second.tables.map((table: { created: boolean }) => table.created)).toEqual([false, false]);
    expect(second.missionNote.created).toBe(false);
    expect(second.grantRequests.map((request: { filed: boolean }) => request.filed)).toEqual([false, false]);
  });
});

describe('bootstrap_project_profile and the pulse', () => {
  it('leaves a paused manager paused and sends it nothing', async () => {
    await fixture.api(`/api/managers/${fixture.lead.id}`, { method: 'PATCH', body: JSON.stringify({ pulseEnabled: false }) });

    await bootstrap();

    const card = await managerCardOf();
    expect(card.pulseEnabled).toBe(false);
    expect(card.lastPulseAt).toBeUndefined();
  });
});

describe('bootstrap_project_profile when something fails midway', () => {
  it('writes nothing at all when the governance queue has no place left for the access requests', async () => {
    const queueCapacity = MAX_PENDING_PROPOSALS_PER_MANAGER + MAX_QUEUED_PROPOSALS_PER_MANAGER;
    for (let index = 0; index < queueCapacity; index += 1) {
      await call(lead, 'propose_law', { body: `Rule number ${index}`, incident: `incident ${index}` });
    }
    const cardBefore = await managerCardOf();

    const result = await call(lead, 'bootstrap_project_profile');

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('governance_queue_full');
    expect(await storesOf()).toEqual([]);
    expect(noteCount()).toBe(0);
    expect(await managerCardOf()).toEqual(cardBefore);
  });
});

describe('bootstrap_project_profile on a project that already has content', () => {
  it('reuses a table of the same name with its rows, and a mission note already linked', async () => {
    const existingTableId = await fixture.createTable(OWN_PROJECT_ID, 'Manager journal');
    const existingNoteId = await fixture.createNote(OWN_PROJECT_ID, 'My own mission');
    await fixture.api(`/api/managers/${fixture.lead.id}`, { method: 'PATCH', body: JSON.stringify({ missionNoteId: existingNoteId }) });

    const report = await bootstrap();

    expect(report.tables.find((table: { name: string }) => table.name === 'Manager journal')).toMatchObject({ id: existingTableId, created: false });
    expect(report.missionNote).toMatchObject({ id: existingNoteId, created: false });
    expect((await managerCardOf()).missionNoteId).toBe(existingNoteId);
    expect(noteCount()).toBe(1);
    expect(await storesOf()).toHaveLength(2);
  });
});

describe('bootstrap_project_profile who may call it', () => {
  it('refuses a session that is not a manager and names no other manager', async () => {
    const result = await call(worker, 'bootstrap_project_profile');

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('not_a_manager');
  });

  it('refuses a manager that targets another manager outside its lineage', async () => {
    const result = await call(lead, 'bootstrap_project_profile', { manager_id: fixture.siblingLead.id });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('outside_lineage');
    expect(await storesOf(siblingLead)).toEqual([]);
  });
});
