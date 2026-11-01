import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ErrorCode, Session } from '@openfleet/shared';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecorder } from '../activity/activityRecorder.js';
import { ActivityRepository } from '../activity/activityRepository.js';
import { applyMigrations } from '../db/migrate.js';
import { recordingActivity } from './recordingActivity.js';
import { refuse } from './toolResults.js';

const CALLER = { id: 'caller-1', name: 'Worker' } as Session;
const FAKE_MUTATING_TOOL = 'a_fake_tool_nobody_catalogued';

let repository: ActivityRepository;
let failures: unknown[];

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  repository = new ActivityRepository(db);
  failures = [];
});

const connectedClientWith = async (handler: () => unknown) => {
  const recorder = new ActivityRecorder({ repository, clock: () => '2026-11-01T10:00:00.000Z', onFailure: (error) => failures.push(error) });
  const server = new McpServer({ name: 'fake', version: '1' });
  const registering = recordingActivity(server, { caller: CALLER, recorder, managerId: 'manager-1' });
  (registering.registerTool as (...args: unknown[]) => unknown).call(registering, FAKE_MUTATING_TOOL, { description: 'fake', inputSchema: {} }, handler);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
};

const outcomeAfterRefusalWith = async (code: ErrorCode) => {
  const client = await connectedClientWith(() => refuse(code, 'refused for the test'));
  await client.callTool({ name: FAKE_MUTATING_TOOL, arguments: {} });
  return repository.list({ limit: 1 }).items[0]?.outcome;
};

describe('the outcome of a refused call', () => {
  it.each<ErrorCode>([
    'unauthorized', 'outside_lineage', 'not_a_manager', 'backlog_write_refused', 'outside_own_repository', 'directory_not_in_project',
    'base_not_read', 'note_not_read', 'findings_required', 'verdict_stale', 'criteria_stale', 'escalation_open', 'question_unclassified',
    'manager_paused', 'row_guard_violation', 'message_held_for_review',
  ])('is denied when the %s rule refuses the caller', async (code) => {
    expect(await outcomeAfterRefusalWith(code)).toBe('denied');
  });

  it.each<ErrorCode>(['note_not_found', 'invalid_body', 'stale_revision', 'duplicate_name', 'daemon_degraded', 'governance_queue_full', 'children_cap'])(
    'is error when the call fails on %s, which is no rule against the caller',
    async (code) => {
      expect(await outcomeAfterRefusalWith(code)).toBe('error');
    },
  );
});

describe('a handler that throws', () => {
  it('records the failure and still lets the throw reach the caller', async () => {
    const client = await connectedClientWith(() => { throw new Error('boom'); });

    const textTheCallerSees = await client.callTool({ name: FAKE_MUTATING_TOOL, arguments: {} }).then(
      (result) => JSON.stringify(result.content),
      (error: unknown) => (error as Error).message,
    );

    expect(textTheCallerSees).toContain('boom');
    expect(repository.list({ limit: 1 }).items[0]).toMatchObject({ action: FAKE_MUTATING_TOOL, outcome: 'error', detail: 'boom' });
  });

  it('does not break the call when the log itself fails', async () => {
    const client = await connectedClientWith(() => ({ content: [{ type: 'text' as const, text: 'fine' }] }));
    (repository as unknown as { insert: () => never }).insert = () => { throw new Error('log down'); };

    const result = await client.callTool({ name: FAKE_MUTATING_TOOL, arguments: {} });

    expect(result.isError).not.toBe(true);
    expect((failures[0] as Error).message).toBe('log down');
  });
});
