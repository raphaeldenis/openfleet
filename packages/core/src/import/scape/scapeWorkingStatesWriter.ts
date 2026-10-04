import type { DatabaseSync } from 'node:sqlite';
import { WORKING_STATE_SECTIONS, type WorkingStateSections } from '@openfleet/shared';
import type { ImportReport } from './importReport.js';
import type { ImportPlan } from './scapePlan.js';
import type { UpsertOutcome } from './scapeTarget.js';

const MANAGER_OUTCOMES_THAT_OWN_THEIR_STATE: UpsertOutcome[] = ['written', 'alreadyPresent'];

const hasTheSectionsOf = (stored: WorkingStateSections, planned: WorkingStateSections) =>
  WORKING_STATE_SECTIONS.every((key) => JSON.stringify(stored[key]) === JSON.stringify(planned[key]));

/**
 * Seeds the working state of each imported manager that has a state file, once. A state already stored is never replaced:
 * the same sections mean it is already seeded, other sections mean OpenFleet has moved on, and that is a conflict.
 */
export function writeWorkingStates(db: DatabaseSync, plan: ImportPlan, report: ImportReport, managerOutcomes: Map<string, UpsertOutcome>): void {
  const counts = report.counts.workingStates;
  for (const planned of plan.workingStates) {
    counts.expected++;
    report.mergedStateSections += planned.mergedSectionCount;
    if (planned.isNotFullyConverted) counts.notConverted++;

    const managerOutcome = managerOutcomes.get(planned.managerId);
    const isManagerOurs = managerOutcome !== undefined && MANAGER_OUTCOMES_THAT_OWN_THEIR_STATE.includes(managerOutcome);
    if (!isManagerOurs) { counts.conflict++; continue; }

    const stored = db.prepare('SELECT sections_json FROM session_working_states WHERE session_id = ?').get(planned.managerId) as { sections_json: string } | undefined;
    if (stored === undefined) {
      db.prepare('INSERT INTO session_working_states (session_id, sections_json, updated_at) VALUES (?, ?, ?)').run(planned.managerId, JSON.stringify(planned.sections), planned.updatedAt);
      counts.written++;
      continue;
    }
    const isAlreadySeeded = hasTheSectionsOf(JSON.parse(stored.sections_json) as WorkingStateSections, planned.sections);
    counts[isAlreadySeeded ? 'alreadyPresent' : 'conflict']++;
  }
}
