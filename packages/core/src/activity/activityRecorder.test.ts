import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { ActivityRecorder, type ActivityDraft } from './activityRecorder.js';
import { ActivityRepository } from './activityRepository.js';

const FIRST_INSTANT = '2026-11-01T10:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

let db: DatabaseSync;
let repository: ActivityRepository;
let now: string;
let failures: unknown[];

const openRecorder = (options: Partial<ConstructorParameters<typeof ActivityRecorder>[0]> = {}) =>
  new ActivityRecorder({ repository, clock: () => now, onFailure: (error) => failures.push(error), ...options });

const aDraft = (overrides: Partial<ActivityDraft> = {}): ActivityDraft => ({
  actorKind: 'agent', actorLabel: 'Worker', source: 'mcp', action: 'create_note', outcome: 'ok', ...overrides,
});

const listAll = () => repository.list({ limit: 200 }).items;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  applyMigrations(db);
  repository = new ActivityRepository(db);
  now = FIRST_INSTANT;
  failures = [];
});

describe('recording an action', () => {
  it('stores who did what to which entity, with the outcome and the duration', () => {
    const recorder = openRecorder();

    recorder.record(aDraft({ sessionId: 's1', managerId: 'm1', entityKind: 'note', entityId: 'n1', entityLabel: 'Plan', durationMs: 12 }));

    expect(listAll()).toEqual([{
      id: 1, at: FIRST_INSTANT, actorKind: 'agent', actorLabel: 'Worker', sessionId: 's1', managerId: 'm1', source: 'mcp',
      action: 'create_note', entityKind: 'note', entityId: 'n1', entityLabel: 'Plan', outcome: 'ok', durationMs: 12,
    }]);
  });

  it('omits the fields the caller did not give', () => {
    const recorder = openRecorder();

    recorder.record(aDraft());

    expect(Object.keys(listAll()[0]!).sort()).toEqual(['action', 'actorKind', 'actorLabel', 'at', 'id', 'outcome', 'source']);
  });
});

describe('masking and bounds', () => {
  it('never stores a secret given in the arguments, the result or the detail', () => {
    const recorder = openRecorder();

    recorder.record(aDraft({
      argsText: 'run --token abc123xyz --name ok',
      resultText: 'Authorization: Bearer sekret-value-1',
      detail: 'fetched from https://user:hunter2@example.test/path',
    }));

    const stored = JSON.stringify(listAll());
    expect(stored).not.toContain('abc123xyz');
    expect(stored).not.toContain('sekret-value-1');
    expect(stored).not.toContain('hunter2');
    expect(stored).toContain('--name ok');
  });

  it('cuts the detail at 300 characters, the arguments at 400 and the result at 200', () => {
    const recorder = openRecorder();
    const long = 'x'.repeat(10_000);

    recorder.record(aDraft({ detail: long, argsText: long, resultText: long }));

    const [row] = listAll();
    expect([row?.detail?.length, row?.argsExcerpt?.length, row?.resultExcerpt?.length]).toEqual([300, 400, 200]);
  });

  it('cuts a label, an entity id and an action that run too long', () => {
    const recorder = openRecorder();
    const long = 'y'.repeat(5_000);

    recorder.record(aDraft({ actorLabel: long, entityId: long, entityLabel: long, action: long }));

    const [row] = listAll();
    expect(Math.max(row!.actorLabel.length, row!.entityId!.length, row!.entityLabel!.length, row!.action.length)).toBeLessThanOrEqual(200);
  });

  it('strips control and bidirectional characters so the stored text is inert', () => {
    const recorder = openRecorder();

    recorder.record(aDraft({ detail: 'ok‮evil\u0000\u0007 text', actorLabel: 'Wor⁦ker' }));

    const [row] = listAll();
    expect(row?.detail).toBe('okevil text');
    expect(row?.actorLabel).toBe('Worker');
  });
});

describe('failing open', () => {
  it('lets the caller continue and reports the failure when the insert throws', () => {
    const failing = Object.assign(Object.create(repository) as ActivityRepository, { insert: () => { throw new Error('disk full'); } });
    const recorder = openRecorder({ repository: failing });

    expect(() => recorder.record(aDraft())).not.toThrow();
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe('disk full');
  });

  it('keeps recording after a failure', () => {
    let shouldFail = true;
    const flaky = Object.assign(Object.create(repository) as ActivityRepository, {
      insert: (row: Parameters<ActivityRepository['insert']>[0]) => { if (shouldFail) throw new Error('locked'); repository.insert(row); },
    });
    const recorder = openRecorder({ repository: flaky });
    recorder.record(aDraft());
    shouldFail = false;

    recorder.record(aDraft({ action: 'update_note' }));

    expect(listAll().map((row) => row.action)).toEqual(['update_note']);
  });
});

describe('reading the log', () => {
  it('lists the newest first and pages with a cursor without duplicate or gap', () => {
    const recorder = openRecorder();
    for (let index = 1; index <= 7; index += 1) recorder.record(aDraft({ action: `a${index}` }));

    const first = repository.list({ limit: 3 });
    const second = repository.list({ limit: 3, cursor: first.nextCursor! });
    const third = repository.list({ limit: 3, cursor: second.nextCursor! });

    expect([...first.items, ...second.items, ...third.items].map((row) => row.action)).toEqual(['a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1']);
    expect(third.nextCursor).toBeUndefined();
  });

  it('filters by actor kind, session, entity kind, action and outcome', () => {
    const recorder = openRecorder();
    recorder.record(aDraft({ actorKind: 'human', source: 'rest', action: 'gate.approve', entityKind: 'gate' }));
    recorder.record(aDraft({ sessionId: 's1', entityKind: 'note' }));
    recorder.record(aDraft({ sessionId: 's2', outcome: 'denied', action: 'delete_note', entityKind: 'note' }));

    const actions = (query: Parameters<ActivityRepository['list']>[0]) => repository.list(query).items.map((row) => row.action);

    expect(actions({ limit: 50, actorKind: 'human' })).toEqual(['gate.approve']);
    expect(actions({ limit: 50, sessionId: 's1' })).toEqual(['create_note']);
    expect(actions({ limit: 50, entityKind: 'note' })).toEqual(['delete_note', 'create_note']);
    expect(actions({ limit: 50, action: 'delete_note' })).toEqual(['delete_note']);
    expect(actions({ limit: 50, outcome: 'denied' })).toEqual(['delete_note']);
  });

  it('filters by time range, bounds included', () => {
    const recorder = openRecorder();
    for (const instant of ['2026-11-01T10:00:00.000Z', '2026-11-01T11:00:00.000Z', '2026-11-01T12:00:00.000Z']) {
      now = instant;
      recorder.record(aDraft({ action: instant.slice(11, 13) }));
    }

    const rows = repository.list({ limit: 50, since: '2026-11-01T11:00:00.000Z', until: '2026-11-01T12:00:00.000Z' });

    expect(rows.items.map((row) => row.action)).toEqual(['12', '11']);
  });

  it('returns only the rows of the manager asked for, never those of another lineage', () => {
    const recorder = openRecorder();
    recorder.record(aDraft({ managerId: 'manager-a', action: 'of_a' }));
    recorder.record(aDraft({ managerId: 'manager-b', action: 'of_b' }));
    recorder.record(aDraft({ action: 'of_nobody' }));

    const rows = repository.list({ limit: 50, managerId: 'manager-a' });

    expect(rows.items.map((row) => row.action)).toEqual(['of_a']);
  });

  it('treats a percent or underscore in a filter as plain text, not a pattern', () => {
    const recorder = openRecorder();
    recorder.record(aDraft({ action: 'create_note' }));

    expect(repository.list({ limit: 50, action: '%' }).items).toEqual([]);
    expect(repository.list({ limit: 50, action: 'create_not_' }).items).toEqual([]);
  });
});

describe('retention', () => {
  it('keeps only the newest rows once the cap is passed', () => {
    const recorder = openRecorder({ retention: { maxRows: 5, maxAgeDays: 90 }, pruneEvery: 1 });

    for (let index = 1; index <= 9; index += 1) recorder.record(aDraft({ action: `a${index}` }));

    expect(listAll().map((row) => row.action)).toEqual(['a9', 'a8', 'a7', 'a6', 'a5']);
  });

  it('drops the rows older than the maximum age and keeps the row just written', () => {
    const recorder = openRecorder({ retention: { maxRows: 1000, maxAgeDays: 90 }, pruneEvery: 1 });
    recorder.record(aDraft({ action: 'old' }));
    now = new Date(Date.parse(FIRST_INSTANT) + 91 * DAY_MS).toISOString();

    recorder.record(aDraft({ action: 'fresh' }));

    expect(listAll().map((row) => row.action)).toEqual(['fresh']);
  });

  it('keeps a row 89 days old', () => {
    const recorder = openRecorder({ retention: { maxRows: 1000, maxAgeDays: 90 }, pruneEvery: 1 });
    recorder.record(aDraft({ action: 'recent' }));
    now = new Date(Date.parse(FIRST_INSTANT) + 89 * DAY_MS).toISOString();

    recorder.record(aDraft({ action: 'fresh' }));

    expect(listAll().map((row) => row.action)).toEqual(['fresh', 'recent']);
  });

  it('prunes only every N inserts', () => {
    const recorder = openRecorder({ retention: { maxRows: 2, maxAgeDays: 90 }, pruneEvery: 4 });

    for (let index = 1; index <= 3; index += 1) recorder.record(aDraft());
    expect(listAll()).toHaveLength(3);
    recorder.record(aDraft());

    expect(listAll()).toHaveLength(2);
  });

  it('prunes at boot, so a log over the cap shrinks without a new write', () => {
    const writer = openRecorder({ retention: { maxRows: 1000, maxAgeDays: 90 }, pruneEvery: 1000 });
    for (let index = 1; index <= 6; index += 1) writer.record(aDraft({ action: `a${index}` }));

    openRecorder({ retention: { maxRows: 3, maxAgeDays: 90 } }).pruneAtBoot();

    expect(listAll().map((row) => row.action)).toEqual(['a6', 'a5', 'a4']);
  });

  it('pages without duplicate or gap across a prune that removes only older rows', () => {
    const recorder = openRecorder({ retention: { maxRows: 5, maxAgeDays: 90 }, pruneEvery: 1 });
    for (let index = 1; index <= 5; index += 1) recorder.record(aDraft({ action: `a${index}` }));
    const first = repository.list({ limit: 2 });

    recorder.record(aDraft({ action: 'a6' }));
    recorder.record(aDraft({ action: 'a7' }));
    const second = repository.list({ limit: 2, cursor: first.nextCursor! });

    expect(first.items.map((row) => row.action)).toEqual(['a5', 'a4']);
    expect(second.items.map((row) => row.action)).toEqual(['a3']);
  });
});
