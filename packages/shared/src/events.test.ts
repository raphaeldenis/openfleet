import { describe, expectTypeOf, it } from 'vitest';
import type { ManagerView } from './managers.js';
import type { ServerEvent } from './events.js';
import type { Session } from './session.js';

// Type-only pins: these ServerEvent variants and the Session field they ride on have no
// runtime behaviour of their own in this task (nothing constructs or parses them yet), so a
// value-level test would be vacuous. expectTypeOf still fails a build if the shape drifts.
describe('ServerEvent', () => {
  it('carries the managers list on a snapshot', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'snapshot' }>['managers']>().toEqualTypeOf<ManagerView[]>();
  });

  it('announces a session model change with its sessionId and the new model', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'session.model_changed' }>>().toEqualTypeOf<{
      type: 'session.model_changed';
      sessionId: string;
      model: string;
    }>();
  });

  it('announces a manager being created with its ManagerView', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'manager.created' }>['manager']>().toEqualTypeOf<ManagerView>();
  });

  it('announces a manager pulse with its ManagerView', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'manager.pulsed' }>['manager']>().toEqualTypeOf<ManagerView>();
  });
});

describe('Session', () => {
  it('exposes an optional permissionMode typed as one of the six documented CLI modes', () => {
    expectTypeOf<Session['permissionMode']>().toEqualTypeOf<
      'manual' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk' | undefined
    >();
  });
});
