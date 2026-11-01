import { randomBytes, randomUUID } from 'node:crypto';
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

  describe('a secret in any shape the three adversarial reviews found', () => {
    // Built at run time: no token-shaped literal sits in the source.
    const fakeSecret = (label: string) => `${label}-${randomBytes(8).toString('hex')}`;
    const storedLog = async () => {
      const response = await fixture.api('/api/activity?limit=200');
      return JSON.stringify(recordedActivity()) + await response.text();
    };
    const expectNoneStored = async (secrets: string[]) => {
      const log = await storedLog();
      for (const secret of secrets) expect(log).not.toContain(secret);
    };

    const SHELL_FORMS: [string, (secret: string, other: string) => string][] = [
      ['a command substitution', (secret) => `deploy --password $(printf '${secret}')`],
      ['backticks after an equals sign', (secret) => `deploy --password=\`printf ${secret}\``],
      ['an ANSI-C quoted header name', (secret) => `curl -H $'\\x41uthorization: ${secret}' https://example.test`],
      ['an ANSI-C quoted command name', (secret) => `$'\\x63url' -u user:${secret} https://example.test`],
      ['a value that starts with a dash', (secret) => `sshpass -p -${secret} ssh host`],
      ['a quoted value of two words', (secret, other) => `deploy --token "first ${secret} second-${other}" --name keep-me`],
      ['an escaped double quote', (secret) => `cmd --password "safe\\" ${secret}" --name keep-me`],
      ['glued single-quoted segments', (secret) => `cmd --password 'safe'\\'' ${secret}' --name keep-me`],
      ['a flag name split by a bidirectional character', (secret) => `deploy --to‮ken ${secret} --name keep-me`],
    ];

    it.each(SHELL_FORMS)('stores neither the arguments nor the result of a note whose body holds %s', async (_label, bodyHolding) => {
      const [secret, other] = [fakeSecret('probe'), fakeSecret('other')];

      const result = await callTool(fixture.worker.id, 'create_note', { title: 'Shell secret', body_md: bodyHolding(secret, other) });

      expect(result.isError).not.toBe(true);
      await expectNoneStored([secret, other]);
    });

    it.each(SHELL_FORMS)('stores no secret held as %s in the nested values, keys and arrays of a call', async (_label, textHolding) => {
      const [secret, other, keySecret] = [fakeSecret('nested'), fakeSecret('other'), fakeSecret('key')];
      const row = { title: textHolding(secret, other), tags: [textHolding(secret, other)], meta: { password: secret, [keySecret]: 1, comment: secret } };

      await callTool(fixture.worker.id, 'insert_data_store_rows', { store: 'no-such-store', rows: [row] });

      expect(recordedActions()).toEqual(['insert_data_store_rows']);
      await expectNoneStored([secret, other, keySecret]);
    });

    it('stores no secret echoed by the error text of a refused call', async () => {
      const secret = fakeSecret('error');

      const result = await callTool(fixture.worker.id, 'delete_note', { note: `missing --password ${secret}` });

      expect(result.isError).toBe(true);
      await expectNoneStored([secret]);
    });

    it('stores no secret sent to the REST API, neither in the body nor in a route parameter', async () => {
      const [inBody, inRoute] = [fakeSecret('body'), fakeSecret('route')];

      await fixture.api('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: 'project-own', title: `t --token ${inBody}`, bodyMd: `--password ${inBody}` }) });
      await fixture.api(`/api/governance/proposals/${encodeURIComponent(`x --password ${inRoute}`)}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });

      expect(recordedActions()).toEqual(['proposal.decide', 'POST /api/notes']);
      await expectNoneStored([inBody, inRoute]);
    });
  });

  describe('the values the Audit reads', () => {
    it('keeps a UUID, a ticket and a status of the arguments readable', async () => {
      const ownerId = randomUUID();

      await callTool(fixture.worker.id, 'insert_data_store_rows', { store: 'no-such-store', rows: [{ ticket: 'ACT-3', status: 'open', owner_id: ownerId }] });

      expect(recordedActivity()[0]?.argsExcerpt).toBe(`{"store":"no-such-store","rows":[{"ticket":"ACT-3","status":"open","owner_id":"${ownerId}"}]}`);
    });

    it('keeps the id of the note a call created readable in the result', async () => {
      const result = await callTool(fixture.worker.id, 'create_note', { title: 'Plan', body_md: 'x' });

      const noteId = (JSON.parse((result.content as { text: string }[])[0]!.text) as { id: string }).id;
      expect(recordedActivity()[0]?.resultExcerpt).toMatch(new RegExp(`^\\[result len=\\d+\\] \\{.*"id":"${noteId}"`));
    });

    it('keeps the error code of a refused call as its detail', async () => {
      await callTool(fixture.worker.id, 'delete_note', { note: 'no-such-note' });

      expect(recordedActivity()[0]).toMatchObject({ outcome: 'error', detail: 'note_not_found' });
    });
  });

  it('lets the call succeed and answer as usual when the log cannot be written', async () => {
    fixture.db.exec('DROP TABLE activity_log');

    const result = await callTool(fixture.worker.id, 'create_note', { title: 'Still works', body_md: 'x' });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ title: 'Still works' });
  });
});
