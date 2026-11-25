import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../db/migrate.js';
import { PlaybookManualRequestRepository } from './playbookManualRequestRepository.js';
import { PlaybookRunRepository } from './playbookRunRepository.js';

let db: DatabaseSync;
let runs: PlaybookRunRepository;
let manual: PlaybookManualRequestRepository;

const parkARun = () => {
  runs.insertRun({ id: 'r1', playbookId: 'pb1', playbookRev: 1, flowSha256: 'sha', inputs: {}, actorKind: 'admin', launchedBy: { kind: 'admin_api', ref: null }, startedAt: '2026-11-12T10:00:00.000Z' });
  runs.insertStep({ runId: 'r1', seq: 1, stepId: 'gate', startedAt: '2026-11-12T10:00:00.000Z' });
  manual.park({ runId: 'r1', seq: 1, promptMasked: 'Ship it?', requestedAt: '2026-11-12T10:00:00.000Z', expiresAt: '2026-11-12T11:00:00.000Z' });
};
const answerOnce = () => manual.answer({ runId: 'r1', seq: 1, decision: 'approved', answeredAt: '2026-11-12T10:05:00.000Z' });

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb1', 'p1', 'P', '[]', '{\"cells\":[]}', '{}', 'native', 't0', 't0')").run();
  runs = new PlaybookRunRepository(db);
  manual = new PlaybookManualRequestRepository(db);
});

describe('the question of a manual step takes one answer', () => {
  it('records the first answer and refuses the second, which changes nothing', () => {
    parkARun();

    const answers = [answerOnce(), answerOnce()];

    expect(answers).toEqual([true, false]);
    expect(manual.get('r1', 1)).toMatchObject({ status: 'answered', decision: 'approved' });
    expect(runs.get('r1')).toMatchObject({ status: 'running', endedAt: null });
  });

  it('refuses an answer to a question that expired', () => {
    parkARun();
    manual.expireOverdue('2026-11-12T11:00:00.000Z');

    expect(answerOnce()).toBe(false);
    expect(runs.get('r1')).toMatchObject({ status: 'failed', errorCode: 'manual_wait_expired' });
  });

  it('refuses an answer given at the instant the wait ends or later, even when nothing ended the wait before, and takes one given a millisecond before', () => {
    parkARun();

    const atTheEnd = manual.answer({ runId: 'r1', seq: 1, decision: 'approved', answeredAt: '2026-11-12T11:00:00.000Z' });
    const afterTheEnd = manual.answer({ runId: 'r1', seq: 1, decision: 'approved', answeredAt: '2026-11-12T11:00:00.001Z' });
    const justBeforeTheEnd = manual.answer({ runId: 'r1', seq: 1, decision: 'approved', answeredAt: '2026-11-12T10:59:59.999Z' });

    expect([atTheEnd, afterTheEnd, justBeforeTheEnd]).toEqual([false, false, true]);
  });

  it('keeps the question pending until its wait is over, and ends it at the very instant it is due', () => {
    parkARun();

    expect(manual.expireOverdue('2026-11-12T10:59:59.999Z')).toEqual([]);
    expect(manual.expireOverdue('2026-11-12T11:00:00.000Z')).toEqual([{ runId: 'r1', playbookId: 'pb1' }]);
  });

  it('ends only the waits of the project named, and leaves the overdue waits of the others pending', () => {
    parkARun();

    expect(manual.expireOverdue('2026-11-12T11:00:00.000Z', { projectId: 'p-other' })).toEqual([]);
    expect(manual.get('r1', 1)?.status).toBe('pending');
    expect(manual.expireOverdue('2026-11-12T11:00:00.000Z', { projectId: 'p1' })).toEqual([{ runId: 'r1', playbookId: 'pb1' }]);
  });
});

describe('the closing of a question that must not go on', () => {
  const closeAt = (at: string) => manual.cancel({ runId: 'r1', seq: 1, errorCode: 'parked_tree_budget_invalid', at });

  it('does not close a question whose wait ends at that instant or before: the end of the wait wins and nothing changes', () => {
    parkARun();

    const atTheEnd = closeAt('2026-11-12T11:00:00.000Z');

    expect(atTheEnd).toBe(false);
    expect(manual.get('r1', 1)?.status).toBe('pending');
    expect(runs.get('r1')).toMatchObject({ status: 'waiting_manual', errorCode: null });
  });

  it('closes a question still open a millisecond before the end, and puts its run in review', () => {
    parkARun();

    const justBeforeTheEnd = closeAt('2026-11-12T10:59:59.999Z');

    expect(justBeforeTheEnd).toBe(true);
    expect(manual.get('r1', 1)?.status).toBe('cancelled');
    expect(runs.get('r1')).toMatchObject({ status: 'needs_review', errorCode: 'parked_tree_budget_invalid' });
  });
});

describe('the abandon of a question on a cancellation', () => {
  const abandonAt = (at: string) => manual.abandonPendingQuestion({ runId: 'r1', errorCode: 'run_cancelled', at });

  it('abandons a question still open a millisecond before the end, and ends its run as failed', () => {
    parkARun();

    const justBeforeTheEnd = abandonAt('2026-11-12T10:59:59.999Z');

    expect(justBeforeTheEnd).toBe('abandoned');
    expect(manual.get('r1', 1)?.status).toBe('cancelled');
    expect(runs.get('r1')).toMatchObject({ status: 'failed', errorCode: 'run_cancelled' });
  });

  it('expires the question of the run when its wait is over at that instant, in the same decision: the end of the wait wins over the cancellation', () => {
    parkARun();

    const atTheEnd = abandonAt('2026-11-12T11:00:00.000Z');

    expect(atTheEnd).toBe('expired');
    expect(manual.get('r1', 1)?.status).toBe('expired');
    expect(runs.get('r1')).toMatchObject({ status: 'failed', errorCode: 'manual_wait_expired' });
  });

  it('answers not_pending, changing nothing, when no question of the run is pending', () => {
    expect(abandonAt('2026-11-12T10:00:00.000Z')).toBe('not_pending');
  });
});
