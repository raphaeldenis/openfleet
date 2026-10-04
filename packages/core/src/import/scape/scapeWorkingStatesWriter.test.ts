import type { DatabaseSync } from 'node:sqlite';
import { MANAGER_ROLE, type WorkingStateSections } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { newToken } from '../../ids.js';
import { SessionRepository } from '../../sessions/sessionRepository.js';
import { emptyReport } from './importReport.js';
import type { ImportPlan } from './scapePlan.js';
import type { UpsertOutcome } from './scapeTarget.js';
import { writeWorkingStates } from './scapeWorkingStatesWriter.js';

const MANAGER_ID = 'writer-test-manager';
const AT = '2026-10-03T08:30:00.000Z';
const sectionsWith = (plan: string[]): WorkingStateSections => ({ plan, todo: [], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [] });

describe('writeWorkingStates', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const [hookToken, mcpToken] = [newToken(), newToken()];
    new SessionRepository(db).insert({
      id: MANAGER_ID, name: 'Writer', emoji: '🤖', directory: '/tmp', worktree: null, model: null, parent_id: null, role: MANAGER_ROLE, harness: 'fake',
      state: 'closed', state_since: AT, hook_token: hookToken, mcp_token: mcpToken, permission_mode: null, branch: null, project_id: null, created_at: AT,
    });
  });
  afterEach(() => db.close());

  const writeSections = (sections: WorkingStateSections) => {
    const plan = { workingStates: [{ managerId: MANAGER_ID, sections, updatedAt: AT, mergedSectionCount: 0, isNotFullyConverted: false }] } as unknown as ImportPlan;
    const report = emptyReport({ dryRun: false });
    writeWorkingStates(db, plan, report, new Map<string, UpsertOutcome>([[MANAGER_ID, 'written']]));
    return report;
  };
  const storedCount = () => (db.prepare('SELECT count(*) AS n FROM session_working_states').get() as { n: number }).n;

  it('writes sections the working state accepts', () => {
    const report = writeSections(sectionsWith(['a plan item']));

    expect(storedCount()).toBe(1);
    expect(report.counts.workingStates).toMatchObject({ expected: 1, written: 1, notConverted: 0 });
  });

  it('writes nothing for sections the working state refuses, and counts them as not converted', () => {
    const report = writeSections(sectionsWith(['an item with a control\u0007character']));

    expect(storedCount()).toBe(0);
    expect(report.counts.workingStates).toMatchObject({ expected: 1, written: 0, notConverted: 1 });
  });
});
