import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { ActivityRepository } from '../activity/activityRepository.js';

let fixture: GovernanceFixture;
// The fixture creates its sessions through the REST API, which the log records; each test starts from an empty log.
beforeEach(async () => {
  fixture = await startGovernanceFixture();
  fixture.db.exec('DELETE FROM activity_log');
});
afterEach(async () => { await fixture.close(); });

const recordedActivity = () => new ActivityRepository(fixture.db).list({ limit: 200 }).items;
const recordedActions = () => recordedActivity().map((row) => row.action);

const callTool = async (sessionId: string, name: string, args: Record<string, unknown>) => {
  const client = await fixture.connect(sessionId);
  return await client.callTool({ name, arguments: args });
};

describe('recording the MCP calls of the daemon booted with its own wiring', () => {
  it('records a mutating call as an agent row naming the session, the tool, the outcome and a duration', async () => {
    const result = await callTool(fixture.worker.id, 'create_note', { title: 'Plan', body_md: '# plan' });

    expect(result.isError).not.toBe(true);
    const [row] = recordedActivity().filter((candidate) => candidate.action === 'create_note');
    expect(row).toMatchObject({ actorKind: 'agent', actorLabel: 'Worker', sessionId: fixture.worker.id, source: 'mcp', action: 'create_note', outcome: 'ok' });
    expect(typeof row?.durationMs).toBe('number');
  });

  it('records no row for a read tool', async () => {
    await callTool(fixture.worker.id, 'list_notes', {});
    await callTool(fixture.worker.id, 'list_sessions', {});

    expect(recordedActions()).toEqual([]);
  });

  it('files a call of a child under the manager at the root of its lineage', async () => {
    const child = await fixture.createSession('Child', { parentId: fixture.lead.id });

    await callTool(child.id, 'create_note', { title: 'Child note', body_md: 'x' });

    const [row] = recordedActivity();
    expect(row).toMatchObject({ sessionId: child.id, managerId: fixture.lead.id });
  });

  it('records the outcome error for a call the tool refuses', async () => {
    const result = await callTool(fixture.worker.id, 'delete_note', { note: 'no-such-note' });

    expect(result.isError).toBe(true);
    expect(recordedActivity()[0]).toMatchObject({ action: 'delete_note', outcome: 'error' });
  });

  it('records the outcome denied for a call outside the caller lineage', async () => {
    const result = await callTool(fixture.worker.id, 'close_session', { session_id: fixture.siblingLead.id });

    expect(result.isError).toBe(true);
    expect(recordedActivity()[0]).toMatchObject({ action: 'close_session', outcome: 'denied' });
  });

  it('never stores a secret given in the arguments', async () => {
    await callTool(fixture.worker.id, 'create_note', { title: 'Notes', body_md: 'curl --token abc123xyz https://user:hunter2@example.test' });

    const stored = JSON.stringify(recordedActivity());
    expect(stored).not.toContain('abc123xyz');
    expect(stored).not.toContain('hunter2');
  });

  describe('a secret that survives a mask applied to serialized text', () => {
    // Built at run time: no token-shaped literal sits in the source.
    const fakeSecret = (label: string) => `${label}-${randomBytes(8).toString('hex')}`;
    const storedLog = async () => {
      const response = await fixture.api('/api/activity?limit=200');
      return JSON.stringify(recordedActivity()) + await response.text();
    };

    it('masks the whole quoted value of a secret flag whose quotes the JSON arguments escape', async () => {
      const firstWord = fakeSecret('first');
      const secondWord = fakeSecret('second');
      const body = `deploy --token "${firstWord} ${secondWord}" --name keep-me`;

      await callTool(fixture.worker.id, 'create_note', { title: 'Quoted secret', body_md: body });

      const log = await storedLog();
      expect(log).not.toContain(firstWord);
      expect(log).not.toContain(secondWord);
      expect(log).toContain('--name keep-me');
    });

    it('masks the value of a secret flag whose name is split by a bidirectional control character', async () => {
      const secret = fakeSecret('bidi');
      const body = `deploy --to‮ken ${secret} --name keep-me`;

      await callTool(fixture.worker.id, 'create_note', { title: 'Bidi secret', body_md: body });

      const log = await storedLog();
      expect(log).not.toContain(secret);
      expect(log).toContain('--name keep-me');
    });
  });

  it('lets the call succeed and answer as usual when the log cannot be written', async () => {
    fixture.db.exec('DROP TABLE activity_log');

    const result = await callTool(fixture.worker.id, 'create_note', { title: 'Still works', body_md: 'x' });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ title: 'Still works' });
  });
});
