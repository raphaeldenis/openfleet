import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService } from '../sessions/sessionService.js';
import { WorkingStateService } from './workingStateService.js';

let db: DatabaseSync;
let sessions: SessionService;
let workingStates: WorkingStateService;
let managerId: string;

beforeEach(async () => {
  db = openDatabase(':memory:');
  sessions = new SessionService({ db, bus: new EventBus(), harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  workingStates = new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: mkdtempSync(join(tmpdir(), 'of-aggregate-')), maxBytes: 8192 });
  managerId = (await sessions.create({ directory: '/tmp', name: 'manager', harness: 'fake', emoji: '🧭' })).id;
  await sessions.create({ directory: '/tmp', name: 'child', harness: 'fake', emoji: '🧒', parentId: managerId });
});

describe('fleetChangedAt is one SQL aggregate', () => {
  it('reads a single aggregate row and materialises no session_events row', () => {
    const preparedSql: string[] = [];
    const rowsMaterialised: unknown[] = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      preparedSql.push(sql);
      const statement = originalPrepare(sql);
      const originalAll = statement.all.bind(statement);
      statement.all = ((...parameters: never[]) => {
        const rows = originalAll(...parameters);
        rowsMaterialised.push(...rows);
        return rows;
      }) as typeof statement.all;
      return statement;
    }) as typeof db.prepare;

    const fleetChangedAt = workingStates.fleetChangedAt(managerId);

    expect(fleetChangedAt).toBeDefined();
    expect(preparedSql).toHaveLength(1);
    expect(preparedSql[0]).toMatch(/MAX\(/i);
    expect(rowsMaterialised).toHaveLength(0);
  });
});
