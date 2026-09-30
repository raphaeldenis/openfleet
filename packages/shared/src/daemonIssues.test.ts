import { describe, expect, expectTypeOf, it } from 'vitest';
import { DEGRADED_CODES, type DaemonIssue } from './daemonIssues.js';
import type { ServerEvent } from './events.js';

describe('DEGRADED_CODES', () => {
  it('lists exactly the five sources of the degraded state', () => {
    expect([...DEGRADED_CODES].sort()).toEqual(['db_stuck', 'docs_folder_unreadable', 'hook_fail_open', 'uncaught_exception', 'ws_broadcast_failed']);
  });
});

describe('the daemon issues on the wire', () => {
  it('announces the full list of issues on every change', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'daemon.issues' }>>().toEqualTypeOf<{ type: 'daemon.issues'; issues: DaemonIssue[] }>();
  });

  it('carries the current issues on a snapshot', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'snapshot' }>['daemonIssues']>().toEqualTypeOf<DaemonIssue[] | undefined>();
  });

  it('describes an issue by its code, its first appearance, a caller-safe message, a ref and a count', () => {
    expectTypeOf<DaemonIssue>().toEqualTypeOf<{ code: (typeof DEGRADED_CODES)[number]; since: string; message: string; id: string; count: number }>();
  });
});
