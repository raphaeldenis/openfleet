import { describe, expect, it } from 'vitest';
import { describeDaemonIssues } from './daemonIssuesReport.js';

const issue = { code: 'db_stuck', since: '2026-10-30T00:00:00.000Z', message: 'The database does not answer.', id: 'iss-1', count: 3 };

describe('describeDaemonIssues', () => {
  it('names the degraded code, the count, the id and the message of every issue', () => {
    const second = { ...issue, code: 'ws_broadcast_failed', id: 'iss-2', count: 1, message: 'A broadcast failed.' };

    const report = describeDaemonIssues({ health: { status: 'degraded', issues: [issue, second] } });

    expect(report).toBe(
      'db_stuck ×3 since 2026-10-30T00:00:00.000Z [iss-1]: The database does not answer.\n' +
        'ws_broadcast_failed ×1 since 2026-10-30T00:00:00.000Z [iss-2]: A broadcast failed.',
    );
  });

  it.each([
    { label: 'no issue', document: { health: { status: 'ok', issues: [] } } },
    { label: 'a document without health', document: {} },
    { label: 'a non-object', document: null },
  ])('returns null for $label', ({ document }) => {
    expect(describeDaemonIssues(document)).toBeNull();
  });
});
