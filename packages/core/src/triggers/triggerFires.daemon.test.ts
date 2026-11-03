import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

let world: TriggerWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const eventOf = (name: string) => ({ session: { id: 'w', name, state: 'closed_with_error' } });

/** A trigger with a cap of two fires a day, offered three events: two complete, the third is cancelled. */
const worldWithThreeFires = async () => {
  world = await startTriggerWorld();
  const lead = await world.createSession('Lead', { manager: world.managerSpec });
  const triggerId = await world.createArmedTrigger({ run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'p' }, policy: { maxFiresPerDay: 2 } });
  for (const key of ['k1', 'k2', 'k3']) world.engine.submit({ triggerId, dedupKey: key, event: eventOf(`secret name ${key}`) });
  return { world, lead, triggerId };
};

const callTool = async (client: Awaited<ReturnType<TriggerWorld['connect']>>, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { text, json: text.startsWith('error') ? undefined : JSON.parse(text) };
};

describe('list_trigger_fires', () => {
  it('lists the fires of a trigger, newest first, with ids, state and reason, and never a dedup key or event text', async () => {
    const { world, lead, triggerId } = await worldWithThreeFires();
    const client = await world.connect(lead.id);

    const { json, text } = await callTool(client, 'list_trigger_fires', { trigger: triggerId });

    expect(json.fires.map((fire: { ledger_state: string; reason?: string }) => [fire.ledger_state, fire.reason])).toEqual([['cancelled', 'daily_cap'], ['completed', undefined], ['completed', undefined]]);
    expect(json.fires[0]).toEqual({ id: expect.any(String), ledger_state: 'cancelled', fired_at: expect.any(String), settled_at: expect.any(String), reason: 'daily_cap', chain_depth: 1 });
    expect(text).not.toContain('secret name');
    expect(text).not.toMatch(/k[123]/);
  });

  it('filters by ledger state and caps the count', async () => {
    const { world, lead, triggerId } = await worldWithThreeFires();
    const client = await world.connect(lead.id);

    const completed = await callTool(client, 'list_trigger_fires', { trigger: triggerId, state: 'completed' });
    const one = await callTool(client, 'list_trigger_fires', { trigger: triggerId, limit: 1 });
    const unknownState = await callTool(client, 'list_trigger_fires', { trigger: triggerId, state: 'maybe' });

    expect(completed.json.fires).toHaveLength(2);
    expect(one.json.fires).toHaveLength(1);
    expect(unknownState.text).toMatch(/^error invalid_body:/);
  });

  it('says trigger_not_found for a trigger that does not exist', async () => {
    const { world, lead } = await worldWithThreeFires();
    const client = await world.connect(lead.id);

    expect((await callTool(client, 'list_trigger_fires', { trigger: 'nope' })).text).toMatch(/^error trigger_not_found:/);
  });
});

describe('GET /api/triggers/:id/fires', () => {
  it('answers the fires to the admin token, and refuses the token of a session and an unknown trigger', async () => {
    const { world, lead, triggerId } = await worldWithThreeFires();
    const { mcp_token } = world.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(lead.id) as { mcp_token: string };

    const admin = await world.api(`/api/triggers/${triggerId}/fires?state=completed`);
    const withSessionToken = await fetch(`${world.daemon.server.url}/api/triggers/${triggerId}/fires`, { headers: { authorization: `Bearer ${mcp_token}` } });
    const unknown = await world.api('/api/triggers/nope/fires');

    expect(admin.status).toBe(200);
    expect((await admin.json() as { fires: unknown[] }).fires).toHaveLength(2);
    expect(withSessionToken.status).toBe(401);
    expect(unknown.status).toBe(404);
  });
});

describe('the trigger.fired event', () => {
  it('reaches a WebSocket client when a fire settles, with ids and the ledger state, and the reason of a cancelled one', async () => {
    world = await startTriggerWorld();
    const lead = await world.createSession('Lead', { manager: world.managerSpec });
    const socket = await world.openSocket();
    const triggerId = await world.createArmedTrigger({ run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'p' }, policy: { maxFiresPerDay: 1 } });

    world.engine.submit({ triggerId, dedupKey: 'k1', event: eventOf('a') });
    world.engine.submit({ triggerId, dedupKey: 'k2', event: eventOf('b') });

    const [first, second] = world.firesOf(triggerId);
    await vi.waitFor(() => expect(socket.framesOfType('trigger.fired')).toEqual([
      { type: 'trigger.fired', triggerId, fireId: first!.id, ledgerState: 'completed' },
      { type: 'trigger.fired', triggerId, fireId: second!.id, ledgerState: 'cancelled', reason: 'daily_cap' },
    ]));
  });
});

describe('the activity log of the engine', () => {
  it('records each settled fire as a system row that holds the id of the trigger and no text of the event', async () => {
    const { world, triggerId } = await worldWithThreeFires();

    const rows = world.db.prepare("SELECT actor_kind, actor_label, source, entity_kind, entity_id, outcome, detail, args_excerpt, result_excerpt FROM activity_log WHERE action = 'trigger.fired' ORDER BY id").all() as Record<string, unknown>[];

    expect(rows.map((row) => [row.actor_kind, row.source, row.entity_kind, row.entity_id, row.outcome])).toEqual([
      ['system', 'daemon', 'trigger', triggerId, 'ok'], ['system', 'daemon', 'trigger', triggerId, 'ok'], ['system', 'daemon', 'trigger', triggerId, 'denied'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('secret name');
  });
});
