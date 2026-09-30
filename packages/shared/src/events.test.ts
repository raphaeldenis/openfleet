import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ErrorEnvelope } from './errors.js';
import { closeReasonOfExitCode } from './events.js';
import type { ManagerView } from './managers.js';
import type { ServerEvent } from './events.js';
import type { Session } from './session.js';
import type { SessionTodos, TodoSummary } from './todos.js';

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

  it('announces an error with an optional sessionId and the ErrorEnvelope', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'error' }>>().toEqualTypeOf<{ type: 'error'; sessionId?: string; error: ErrorEnvelope }>();
  });

  it('closes a session with an optional exitCode and an optional reason', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'session.closed' }>>().toEqualTypeOf<{
      type: 'session.closed';
      sessionId: string;
      exitCode?: number;
      reason?: 'launch_failed' | 'resume_timeout' | 'harness_exit' | 'closed_by_user' | 'daemon_shutdown';
    }>();
  });

  it('announces a session todo list change with the full SessionTodos', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'session.todos' }>>().toEqualTypeOf<{ type: 'session.todos'; todos: SessionTodos }>();
  });

  it('carries optional todo summaries on a snapshot, absent when the daemon has no todo tracker', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'snapshot' }>['todoSummaries']>().toEqualTypeOf<TodoSummary[] | undefined>();
  });

  it('announces a session update (rename) with the full updated Session', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'session.updated' }>['session']>().toEqualTypeOf<Session>();
  });
});

describe('closeReasonOfExitCode', () => {
  it('recomputes the reasons the -1 and -2 exit code convention encodes', () => {
    expect(closeReasonOfExitCode(-1)).toBe('resume_timeout');
    expect(closeReasonOfExitCode(-2)).toBe('launch_failed');
  });

  it('leaves every other exit code without a reason: the process exit and the user close are indistinguishable there', () => {
    expect([undefined, 0, 1, 137].map(closeReasonOfExitCode)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('Session', () => {
  it('exposes an optional permissionMode typed as one of the six documented CLI modes', () => {
    expectTypeOf<Session['permissionMode']>().toEqualTypeOf<
      'manual' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk' | undefined
    >();
  });

  it('exposes an optional branch, the worktree branch it was created on', () => {
    expectTypeOf<Session['branch']>().toEqualTypeOf<string | undefined>();
  });
});
