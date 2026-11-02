import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, OTHER_PROJECT_ID, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { ARBITER_TOOL_NAMES } from './arbiterTools.js';

type Client = Awaited<ReturnType<GovernanceFixture['connect']>>;
type TriggerView = {
  id: string; title: string; project_id: string; content_rev: number; armed: boolean;
  when: Record<string, unknown>; run: Record<string, unknown>; policy: Record<string, unknown>;
  conditions: { id: string; lhs: string; op: string; rhs?: unknown; join: string; case_insensitive: boolean }[];
};

const TRIGGER_TOOLS = [
  'get_trigger_schema', 'list_triggers', 'get_trigger', 'create_trigger', 'delete_trigger', 'set_trigger_when', 'set_trigger_run',
  'set_trigger_policy', 'add_trigger_condition', 'update_trigger_condition', 'delete_trigger_condition',
];

let fixture: GovernanceFixture;
let lead: Client;
beforeEach(async () => {
  fixture = await startGovernanceFixture();
  lead = await fixture.connect(fixture.lead.id);
});
afterEach(async () => { await fixture.close(); });

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError === true, text, json: result.isError === true ? undefined : JSON.parse(text) };
};
const created = async (title = 'Backlog watch'): Promise<TriggerView> => (await call(lead, 'create_trigger', { title })).json as TriggerView;
const viewOf = async (trigger: string, client = lead): Promise<TriggerView> => (await call(client, 'get_trigger', { trigger })).json as TriggerView;
const conditionOf = (lhs: string, op = 'eq', rhs: unknown = 'x') => ({ lhs, op, rhs });

describe('get_trigger_schema', () => {
  it('lists the five sources without webhook, the run kinds with the alias, the 12 operators, the cap and the policy enums', async () => {
    const { json } = await call(lead, 'get_trigger_schema');

    expect(json.when.sources.map((source: { source: string }) => source.source).sort()).toEqual(['cron', 'data_store_query', 'integration_records', 'session_state', 'silent_run']);
    expect(json.run.kinds.map((kind: { kind: string }) => kind.kind).sort()).toEqual(['close_session', 'notify', 'prompt_manager', 'prompt_session', 'run_playbook']);
    expect(json.run.aliases).toEqual({ prompt_argus: 'prompt_manager' });
    expect(json.conditions.ops).toHaveLength(12);
    expect(json.conditions.max).toBe(32);
    expect(json.policy.enums).toEqual({ backlogPolicy: ['discard_stale', 'fire_all', 'fire_latest_only'], batchMode: ['per_batch', 'per_event'] });
  });
});

describe('create_trigger, list_triggers, get_trigger', () => {
  it('creates an unarmed trigger at revision 1 in the project of the caller, readable by id and by exact title', async () => {
    const trigger = await created('Backlog watch');

    expect(trigger).toMatchObject({ title: 'Backlog watch', project_id: 'project-own', content_rev: 1, armed: false, conditions: [] });
    expect(await viewOf(trigger.id)).toEqual(trigger);
    expect(await viewOf('Backlog watch')).toEqual(trigger);
    expect((await call(lead, 'list_triggers')).json.triggers.map((listed: { id: string }) => listed.id)).toEqual([trigger.id]);
  });

  it('does not show a trigger of another project, whatever its id or title', async () => {
    const foreign = await (await fixture.api('/api/triggers', { method: 'POST', body: JSON.stringify({ projectId: OTHER_PROJECT_ID, title: 'Foreign' }) })).json() as { id: string };

    expect((await call(lead, 'get_trigger', { trigger: foreign.id })).text).toMatch(/^error trigger_not_found:/);
    expect((await call(lead, 'get_trigger', { trigger: 'Foreign' })).text).toMatch(/^error trigger_not_found:/);
    expect((await call(lead, 'list_triggers')).json.triggers).toEqual([]);
  });

  it('refuses an ambiguous title', async () => {
    await created('Twin');
    await created('Twin');

    expect((await call(lead, 'get_trigger', { trigger: 'Twin' })).text).toMatch(/^error invalid_body: .*ambiguous/);
  });

  it('lets a plain worker of the project create a trigger too, since only a human arms it', async () => {
    const worker = await fixture.connect(fixture.worker.id);

    expect((await call(worker, 'create_trigger', { title: 'From worker' })).isError).toBe(false);
  });
});

describe('set_trigger_when, set_trigger_run, set_trigger_policy', () => {
  it('replaces the WHEN and bumps the revision', async () => {
    const trigger = await created();

    const { json } = await call(lead, 'set_trigger_when', { trigger: trigger.id, kind: 'silent_run', args: { minutes: 15 } });

    expect(json.when).toEqual({ source: 'silent_run', minutes: 15 });
    expect(json.content_rev).toBe(2);
  });

  it('refuses webhook and a configuration that does not fit its source', async () => {
    const trigger = await created();

    expect((await call(lead, 'set_trigger_when', { trigger: trigger.id, kind: 'webhook', args: { webhookName: 'x', verification: 'none' } })).isError).toBe(true);
    expect((await call(lead, 'set_trigger_when', { trigger: trigger.id, kind: 'data_store_query', args: { storeId: 's1', event: 'row_count' } })).text).toMatch(/^error invalid_body:/);
    expect((await viewOf(trigger.id)).content_rev).toBe(1);
  });

  it('stores prompt_argus as prompt_manager', async () => {
    const trigger = await created();

    const { json } = await call(lead, 'set_trigger_run', { trigger: trigger.id, kind: 'prompt_argus', args: { argusId: fixture.lead.id, prompt: 'The backlog has a new task.' } });

    expect(json.run).toEqual({ kind: 'prompt_manager', managerId: fixture.lead.id, prompt: 'The backlog has a new task.' });
  });

  it('merges the fields given into the policy and keeps the others', async () => {
    const trigger = await created();
    await call(lead, 'set_trigger_policy', { trigger: trigger.id, cooldown_seconds: 60 });

    const { json } = await call(lead, 'set_trigger_policy', { trigger: trigger.id, max_fires_per_day: 5, backlog_policy: 'discard_stale', backlog_max_age_minutes: 30 });

    expect(json.policy).toEqual({ cooldownSeconds: 60, maxFiresPerDay: 5, batchMode: 'per_event', backlogPolicy: 'discard_stale', backlogMaxAgeMinutes: 30 });
    expect(json.content_rev).toBe(3);
  });

  it('refuses a write whose expected_rev is stale and writes nothing', async () => {
    const trigger = await created();
    await call(lead, 'set_trigger_policy', { trigger: trigger.id, cooldown_seconds: 1 });

    const stale = await call(lead, 'set_trigger_policy', { trigger: trigger.id, cooldown_seconds: 99, expected_rev: 1 });

    expect(stale.text).toMatch(/^error stale_revision: .*current rev: 2.* \(retry: after_refresh\)$/);
    expect((await viewOf(trigger.id)).policy).toMatchObject({ cooldownSeconds: 1 });
  });

  it('accepts a write whose expected_rev is current', async () => {
    const trigger = await created();

    const { json } = await call(lead, 'set_trigger_policy', { trigger: trigger.id, cooldown_seconds: 1, expected_rev: 1 });

    expect(json.content_rev).toBe(2);
  });
});

describe('the conditions of a trigger', () => {
  it('adds conditions in order, inserts after a given one, and gives each an id', async () => {
    const trigger = await created();
    const first = (await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.session.name', 'contains', 'api') })).json as TriggerView;
    await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.session.state'), join: 'or' });
    const inserted = (await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.session.role'), after: first.conditions[0]!.id })).json as TriggerView;

    expect(inserted.conditions.map((condition) => condition.lhs)).toEqual(['event.session.name', 'event.session.role', 'event.session.state']);
    expect(new Set(inserted.conditions.map((condition) => condition.id)).size).toBe(3);
    expect(inserted.conditions[2]!.join).toBe('or');
    expect(inserted.content_rev).toBe(4);
  });

  it('makes the join of the first condition "and" whatever was asked', async () => {
    const trigger = await created();

    const { json } = await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.session.name'), join: 'or' });

    expect(json.conditions[0].join).toBe('and');
  });

  it('updates one condition and deletes another by id', async () => {
    const trigger = await created();
    await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.session.name') });
    const two = (await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.session.state') })).json as TriggerView;
    const [firstId, secondId] = two.conditions.map((condition) => condition.id);

    const updated = (await call(lead, 'update_trigger_condition', { trigger: trigger.id, condition_id: firstId, op: 'neq', rhs: 'y', case_insensitive: true })).json as TriggerView;
    const deleted = (await call(lead, 'delete_trigger_condition', { trigger: trigger.id, condition_id: secondId })).json as TriggerView;

    expect(updated.conditions[0]).toMatchObject({ op: 'neq', rhs: 'y', case_insensitive: true });
    expect(deleted.conditions.map((condition) => condition.id)).toEqual([firstId]);
  });

  it('refuses an unknown condition id', async () => {
    const trigger = await created();

    expect((await call(lead, 'delete_trigger_condition', { trigger: trigger.id, condition_id: 'nope' })).text).toMatch(/^error trigger_condition_not_found:/);
    expect((await call(lead, 'update_trigger_condition', { trigger: trigger.id, condition_id: 'nope', op: 'eq' })).text).toMatch(/^error trigger_condition_not_found:/);
  });

  it('refuses an operator outside the twelve of the evaluator, and a missing value for an operator that compares', async () => {
    const trigger = await created();

    expect((await call(lead, 'add_trigger_condition', { trigger: trigger.id, lhs: 'event.session.name', op: 'matches', rhs: 'x' })).text).toMatch(/^error invalid_body:/);
    expect((await call(lead, 'add_trigger_condition', { trigger: trigger.id, lhs: 'event.session.name', op: 'eq' })).text).toMatch(/^error invalid_body:/);
    expect((await call(lead, 'add_trigger_condition', { trigger: trigger.id, lhs: 'event.session.name', op: 'exists' })).isError).toBe(false);
  });

  it('holds 32 conditions and refuses the 33rd', async () => {
    const trigger = await created();
    for (let position = 0; position < 32; position += 1) {
      expect((await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf(`event.session.field${position}`) })).isError).toBe(false);
    }

    const thirtyThird = await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.session.one_more') });

    expect(thirtyThird.text).toMatch(/^error too_many_conditions:/);
    expect((await viewOf(trigger.id)).conditions).toHaveLength(32);
  });
});

describe('the prefix lint of the condition paths (TRIG-FIELD-LINT01)', () => {
  const tableTrigger = async () => {
    const trigger = await created();
    await call(lead, 'set_trigger_when', { trigger: trigger.id, kind: 'data_store_query', args: { storeId: 's1', event: 'new_matching_rows' } });
    return trigger;
  };

  it('refuses event.record.* on a table trigger and names event.row.*', async () => {
    const trigger = await tableTrigger();

    const refused = await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.record.title') });

    expect(refused.text).toMatch(/^error trigger_field_prefix: .*event\.row\./);
    expect((await viewOf(trigger.id)).conditions).toEqual([]);
  });

  it('accepts event.row.* and event.previous.* on a table trigger', async () => {
    const trigger = await tableTrigger();

    expect((await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.row.title') })).isError).toBe(false);
    expect((await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.previous.title') })).isError).toBe(false);
  });

  it('refuses event.row.* on an integration trigger and names event.record.*', async () => {
    const trigger = await created();
    await call(lead, 'set_trigger_when', { trigger: trigger.id, kind: 'integration_records', args: { itemId: 'i1', event: 'new_record' } });

    const refused = await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.row.title') });

    expect(refused.text).toMatch(/^error trigger_field_prefix: .*event\.record\./);
  });

  it('refuses a path outside the event namespace', async () => {
    const trigger = await created();

    expect((await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('steps.a.b') })).text).toMatch(/^error trigger_field_prefix:/);
  });

  it('refuses the update of a condition to a wrong prefix', async () => {
    const trigger = await tableTrigger();
    const added = (await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.row.title') })).json as TriggerView;

    const refused = await call(lead, 'update_trigger_condition', { trigger: trigger.id, condition_id: added.conditions[0]!.id, lhs: 'event.record.title' });

    expect(refused.text).toMatch(/^error trigger_field_prefix: .*event\.row\./);
  });

  it('refuses to move the WHEN to a source whose prefix the existing conditions do not use', async () => {
    const trigger = await tableTrigger();
    await call(lead, 'add_trigger_condition', { trigger: trigger.id, ...conditionOf('event.row.title') });

    const refused = await call(lead, 'set_trigger_when', { trigger: trigger.id, kind: 'integration_records', args: { itemId: 'i1', event: 'new_record' } });

    expect(refused.text).toMatch(/^error trigger_field_prefix: .*event\.record\./);
    expect((await viewOf(trigger.id)).when).toMatchObject({ source: 'data_store_query' });
  });
});

describe('delete_trigger', () => {
  it('removes the trigger, and a second delete says it is gone', async () => {
    const trigger = await created();

    expect((await call(lead, 'delete_trigger', { trigger: trigger.id })).json).toEqual({ deleted: trigger.id });
    expect((await call(lead, 'delete_trigger', { trigger: trigger.id })).text).toMatch(/^error trigger_not_found:/);
  });
});

describe('the tools a session sees', () => {
  it('offers eleven trigger tools and no tool that arms', async () => {
    const names = (await lead.listTools()).tools.map((tool) => tool.name);

    expect(names.filter((name) => TRIGGER_TOOLS.includes(name)).sort()).toEqual([...TRIGGER_TOOLS].sort());
    expect(names.filter((name) => /arm/.test(name))).toEqual([]);
    expect(names).not.toContain('list_trigger_fires');
  });

  it('shows a reviewer none of them', async () => {
    const reviewer = await fixture.connect((await fixture.createSession('Reviewer', { role: 'reviewer' })).id);

    const names = (await reviewer.listTools()).tools.map((tool) => tool.name);

    expect(names.filter((name) => name.includes('trigger'))).toEqual([]);
  });

  it('gives an arbiter none of them', () => {
    expect([...ARBITER_TOOL_NAMES].filter((name) => name.includes('trigger'))).toEqual([]);
  });
});

describe('the activity log of the trigger tools', () => {
  it('keeps no free text of a create_trigger, a WHEN, a RUN or a condition', async () => {
    const canary = `canary free text ${crypto.randomUUID()}`;
    const trigger = (await call(lead, 'create_trigger', { title: canary })).json as TriggerView;
    await call(lead, 'set_trigger_run', { trigger: trigger.id, kind: 'prompt_manager', args: { prompt: canary } });
    await call(lead, 'add_trigger_condition', { trigger: trigger.id, lhs: 'event.session.name', op: 'contains', rhs: canary });
    await call(lead, 'set_trigger_when', { trigger: trigger.id, kind: 'data_store_query', args: { storeId: 's1', event: 'new_matching_rows' } });

    const rows = fixture.db.prepare('SELECT action, entity_label, detail, args_excerpt, result_excerpt FROM activity_log').all();
    const triggerRows = rows.filter((row) => String(row.action).includes('trigger'));

    expect(triggerRows.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(rows)).not.toContain('canary');
    expect(JSON.stringify(rows)).not.toContain(canary.split(' ').at(-1));
  });

  it('keeps the vocabulary words: the source, the run kind and the identifiers', async () => {
    const trigger = await created();
    await call(lead, 'set_trigger_when', { trigger: trigger.id, kind: 'silent_run', args: { minutes: 15 } });

    const row = fixture.db.prepare("SELECT args_excerpt FROM activity_log WHERE action = 'set_trigger_when'").get() as { args_excerpt: string };

    expect(JSON.parse(row.args_excerpt)).toMatchObject({ trigger: trigger.id, kind: 'silent_run' });
  });
});
