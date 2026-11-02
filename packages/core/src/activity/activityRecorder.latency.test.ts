import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { ActivityRecorder } from './activityRecorder.js';
import { ActivityRepository } from './activityRepository.js';

const CALLS_MEASURED = 3000;
// Cold measure: ~0.1-0.2 ms per call. 10 ms leaves room for a machine under load (30+) and still
// catches a change of shape, being 40x or more the cold measure.
const MAX_MEAN_MILLISECONDS_PER_CALL = 10;

const directories = createTempDirTracker();
afterAll(() => directories.removeAll());

describe('the cost of recording one action', () => {
  it('stays within the per-call budget on a file database in WAL mode, masking and pruning included', () => {
    const db = openDatabase(join(directories.make('activity-latency-'), 'openfleet.db'));
    const recorder = new ActivityRecorder({ repository: new ActivityRepository(db), clock: () => new Date().toISOString(), onFailure: (error) => { throw error; } });
    const args = { project_id: 'p1', title: 'Plan', body_md: 'x'.repeat(2000), note: '--token abc123 Authorization: Bearer xyz', status: 'open' };

    const startedAt = performance.now();
    for (let call = 0; call < CALLS_MEASURED; call += 1) {
      recorder.record({ actorKind: 'agent', actorLabel: 'Worker', sessionId: 's1', managerId: 'm1', source: 'mcp', action: 'create_note', outcome: 'ok', durationMs: 3, args, resultText: '{"id":"n1"}' });
    }
    const meanMilliseconds = (performance.now() - startedAt) / CALLS_MEASURED;
    db.close();

    console.info(`[activity latency] mean ${(meanMilliseconds * 1000).toFixed(0)} microseconds per recorded call over ${CALLS_MEASURED} calls`);
    expect(meanMilliseconds).toBeLessThan(MAX_MEAN_MILLISECONDS_PER_CALL);
  });
});
