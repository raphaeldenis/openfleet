import type { DatabaseSync } from 'node:sqlite';
import { WORKING_STATE_SECTIONS, WorkingStateSectionsSchema, type WorkingStateSections } from '@openfleet/shared';
import { countOutcome, type ImportReport } from './importReport.js';
import { ImportLedger } from './scapeLedger.js';
import type { ImportPlan } from './scapePlan.js';
import type { PlannedWorkingState } from './scapeWorkingStates.js';
import { reconcileRecord, type UpsertOutcome } from './scapeTarget.js';

const MANAGER_OUTCOMES_THAT_OWN_THEIR_STATE: UpsertOutcome[] = ['written', 'updated', 'alreadyPresent'];

/** The sections in their fixed order, so that two states with the same sections are the same text. */
const canonicalSectionsOf = (sections: WorkingStateSections): string => JSON.stringify(WORKING_STATE_SECTIONS.map((key) => sections[key]));

function writeWorkingState(input: { db: DatabaseSync; ledger: ImportLedger; planned: PlannedWorkingState }): UpsertOutcome {
  const { db, ledger, planned } = input;
  const sectionsJson = JSON.stringify(planned.sections);
  return reconcileRecord({
    ledger, kind: 'working_state', id: planned.managerId, planned: { sections: canonicalSectionsOf(planned.sections) }, policy: {},
    gateway: {
      readStored: () => {
        const stored = db.prepare('SELECT sections_json FROM session_working_states WHERE session_id = ?').get(planned.managerId) as { sections_json: string } | undefined;
        return stored === undefined ? undefined : { sections: canonicalSectionsOf(JSON.parse(stored.sections_json) as WorkingStateSections) };
      },
      insert: () => { db.prepare('INSERT INTO session_working_states (session_id, sections_json, updated_at) VALUES (?, ?, ?)').run(planned.managerId, sectionsJson, planned.updatedAt); },
      update: () => { db.prepare('UPDATE session_working_states SET sections_json = ?, updated_at = ? WHERE session_id = ?').run(sectionsJson, planned.updatedAt, planned.managerId); },
    },
  });
}

/**
 * Seeds the working state of each imported manager that has a state file. A state OpenFleet moved on from since the last import is a conflict
 * and is never replaced; one equal to what the last import wrote follows the state file.
 */
export function writeWorkingStates(db: DatabaseSync, plan: ImportPlan, report: ImportReport, managerOutcomes: Map<string, UpsertOutcome>): void {
  const ledger = new ImportLedger(db);
  const counts = report.counts.workingStates;
  for (const planned of plan.workingStates) {
    counts.expected++;
    report.mergedStateSections += planned.mergedSectionCount;

    const isRefusedByTheWorkingState = !WorkingStateSectionsSchema.safeParse(planned.sections).success;
    const managerOutcome = managerOutcomes.get(planned.managerId);
    const isManagerOurs = managerOutcome !== undefined && MANAGER_OUTCOMES_THAT_OWN_THEIR_STATE.includes(managerOutcome);
    if (planned.isNotFullyConverted || isRefusedByTheWorkingState || !isManagerOurs) counts.notConverted++;
    if (isRefusedByTheWorkingState) continue;
    if (!isManagerOurs) { counts.conflict++; continue; }

    countOutcome(counts, writeWorkingState({ db, ledger, planned }));
  }
}
