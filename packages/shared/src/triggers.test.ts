import { describe, expect, it } from 'vitest';
import { TriggerPolicySchema, TriggerRunSchema, TriggerWhenSchema, TRIGGER_WHEN_SOURCES } from './triggers.js';

describe('the WHEN of a trigger', () => {
  it('names the five sources and leaves webhook out', () => {
    expect([...TRIGGER_WHEN_SOURCES].sort()).toEqual(['cron', 'data_store_query', 'integration_records', 'session_state', 'silent_run']);
    expect(TriggerWhenSchema.safeParse({ source: 'webhook', webhookName: 'x', verification: 'none' }).success).toBe(false);
  });

  it.each([
    ['session_state idle', { source: 'session_state', state: 'idle', minutes: 10 }],
    ['session_state closed_with_error', { source: 'session_state', state: 'closed_with_error' }],
    ['silent_run', { source: 'silent_run', minutes: 15 }],
    ['data_store_query new rows', { source: 'data_store_query', storeId: 's1', event: 'new_matching_rows' }],
    ['data_store_query row_count', { source: 'data_store_query', storeId: 's1', event: 'row_count', op: 'gte', value: 3 }],
    ['cron', { source: 'cron', expression: '*/5 * * * *', timezone: 'Europe/Paris', catchUp: 'run_once' }],
    ['integration_records', { source: 'integration_records', integrationId: 'i1', event: 'changed_record', keyPrefix: 'CCM', statuses: ['Done', 'In Review'] }],
    ['integration_records with the defaults', { source: 'integration_records', integrationId: 'i1' }],
  ])('accepts the configuration of %s', (_name, when) => {
    expect(TriggerWhenSchema.safeParse(when).success).toBe(true);
  });

  it.each([
    ['row_count without op and value', { source: 'data_store_query', storeId: 's1', event: 'row_count' }],
    ['row_count with a non finite value', { source: 'data_store_query', storeId: 's1', event: 'row_count', op: 'gt', value: Number.POSITIVE_INFINITY }],
    ['an integration_records without integration', { source: 'integration_records', event: 'new_record' }],
    ['an integration_records of the former shape', { source: 'integration_records', itemId: 'i1', event: 'new_record' }],
    ['an integration_records with an unknown event', { source: 'integration_records', integrationId: 'i1', event: 'record_removed' }],
    ['an integration_records with a key prefix that is not a project key', { source: 'integration_records', integrationId: 'i1', keyPrefix: 'ccm-1' }],
    ['an integration_records with no status in the list', { source: 'integration_records', integrationId: 'i1', statuses: [] }],
    ['an integration_records with nine statuses', { source: 'integration_records', integrationId: 'i1', statuses: Array.from({ length: 9 }, (_, index) => `S${index}`) }],
    ['an integration_records with a status of 65 characters', { source: 'integration_records', integrationId: 'i1', statuses: ['x'.repeat(65)] }],
    ['idle without minutes', { source: 'session_state', state: 'idle' }],
    ['cron with four fields', { source: 'cron', expression: '* * * *', timezone: 'Europe/Paris' }],
    ['cron with an unknown zone', { source: 'cron', expression: '* * * * *', timezone: 'Mars/Olympus' }],
    ['an unknown key', { source: 'silent_run', minutes: 5, extra: true }],
  ])('refuses %s', (_name, when) => {
    expect(TriggerWhenSchema.safeParse(when).success).toBe(false);
  });
});

describe('the RUN of a trigger', () => {
  it('reads prompt_argus and argusId as the aliases of prompt_manager and managerId', () => {
    const parsed = TriggerRunSchema.parse({ kind: 'prompt_argus', argusId: 'm1', prompt: 'wake up' });

    expect(parsed).toEqual({ kind: 'prompt_manager', managerId: 'm1', prompt: 'wake up' });
  });

  it.each([
    { kind: 'prompt_manager', prompt: 'hello' },
    { kind: 'notify', title: 'T', message: 'M' },
    { kind: 'prompt_session', sessionId: 's1', prompt: 'p' },
    { kind: 'close_session', sessionId: 's1' },
    { kind: 'run_playbook', playbookId: 'pb1', inputs: { a: 1 } },
  ])('accepts %j', (run) => {
    expect(TriggerRunSchema.safeParse(run).success).toBe(true);
  });

  it('refuses an unknown kind and a prompt that is blank', () => {
    expect(TriggerRunSchema.safeParse({ kind: 'shell', command: 'ls' }).success).toBe(false);
    expect(TriggerRunSchema.safeParse({ kind: 'prompt_manager', prompt: '  ' }).success).toBe(false);
  });
});

describe('the policy of a trigger', () => {
  it('defaults to no cooldown, per event, fire_all', () => {
    expect(TriggerPolicySchema.parse({})).toEqual({ cooldownSeconds: 0, batchMode: 'per_event', backlogPolicy: 'fire_all' });
  });

  it.each([{ cooldownSeconds: -1 }, { maxFiresPerDay: 0 }, { batchMode: 'per_lot' }, { backlogPolicy: 'fire_some' }, { backlogMaxAgeMinutes: 0 }])('refuses %j', (policy) => {
    expect(TriggerPolicySchema.safeParse(policy).success).toBe(false);
  });
});
