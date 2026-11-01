import { OpenFleetError } from '@openfleet/shared';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecorder } from '../activity/activityRecorder.js';
import { ActivityRepository } from '../activity/activityRepository.js';
import { applyMigrations } from '../db/migrate.js';
import { recordedAsHumanAction } from './recordedAsHumanAction.js';

let repository: ActivityRepository;
let recorder: ActivityRecorder;

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  repository = new ActivityRepository(db);
  recorder = new ActivityRecorder({ repository, clock: () => '2026-11-01T10:00:00.000Z', onFailure: () => {} });
});

const rows = () => repository.list({ limit: 50 }).items;
const request = (overrides: Partial<Parameters<typeof recordedAsHumanAction>[1]> = {}) =>
  ({ method: 'POST', template: '/api/governance/laws/:id/withdraw', params: { id: 'law-1' }, ...overrides });

describe('recording a human REST action', () => {
  it('records a successful mutation as an admin row naming the action and the entity', async () => {
    await recordedAsHumanAction(recorder, request(), async () => {});

    expect(rows()).toEqual([expect.objectContaining({
      actorKind: 'human', actorLabel: 'admin', source: 'rest', action: 'law.withdraw', entityKind: 'law', entityId: 'law-1', outcome: 'ok',
    })]);
    expect(typeof rows()[0]?.durationMs).toBe('number');
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('records nothing for a %s', async (method) => {
    await recordedAsHumanAction(recorder, request({ method }), async () => {});

    expect(rows()).toEqual([]);
  });

  it('records nothing for the ticket the app asks before it opens its live connection, which is no action', async () => {
    await recordedAsHumanAction(recorder, request({ template: '/api/ws-ticket', params: {} }), async () => {});

    expect(rows()).toEqual([]);
  });

  it('records the code of a failure as error and lets the failure reach the caller', async () => {
    const failing = recordedAsHumanAction(recorder, request(), async () => { throw new OpenFleetError('law_not_found', 'no such law'); });

    await expect(failing).rejects.toThrow('no such law');
    expect(rows()[0]).toMatchObject({ outcome: 'error', detail: 'law_not_found' });
  });

  it('records a rule refusal as denied', async () => {
    const refused = recordedAsHumanAction(recorder, request(), async () => { throw new OpenFleetError('not_a_manager', 'not a manager'); });

    await expect(refused).rejects.toThrow();
    expect(rows()[0]).toMatchObject({ outcome: 'denied', detail: 'not_a_manager' });
  });

  it('records a failure that is no daemon error as error without leaking its message', async () => {
    const failing = recordedAsHumanAction(recorder, request(), async () => { throw new TypeError('secret detail from deep inside'); });

    await expect(failing).rejects.toThrow(TypeError);
    expect(rows()[0]).toMatchObject({ outcome: 'error', detail: 'TypeError' });
  });

  it('stores an error class named by a secret as its length, on a decision whose id is that secret', async () => {
    // Built at run time: no token-shaped literal sits in the source.
    const secret = `probe-${randomBytes(8).toString('hex')}`;
    const namedBySecret = Object.assign(new Error('boom'), { name: secret });
    const decision = request({ template: '/api/governance/proposals/:id/decide', params: { id: `${secret} x` } });

    await expect(recordedAsHumanAction(recorder, decision, async () => { throw namedBySecret; })).rejects.toThrow('boom');

    expect(JSON.stringify(rows())).not.toContain(secret);
    expect(rows()[0]).toMatchObject({ action: 'proposal.decide', entityId: `[text len=${secret.length + 2}]`, detail: `[text len=${secret.length}]` });
  });
});
