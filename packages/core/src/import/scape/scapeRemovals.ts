import type { ImportReport } from './importReport.js';
import { ENTITY_OF_LEDGER_KIND, LEDGER_KINDS, type ImportLedger, type LedgerKind } from './scapeLedger.js';
import { playbookArchiveVersionIdOf } from './playbookArchive.js';
import { memoryFileIdOf } from './scapeMemories.js';
import type { ImportPlan } from './scapePlan.js';

function plannedIdsByKind(plan: ImportPlan): Record<LedgerKind, Set<string>> {
  const ids = (records: { id: string }[]) => new Set(records.map((record) => record.id));
  return {
    project: ids(plan.projects),
    note: ids(plan.notes),
    note_version: new Set([...plan.noteVersions.map((version) => version.id), ...plan.playbookArchives.map((archive) => playbookArchiveVersionIdOf(archive.id))]),
    playbook_archive: ids(plan.playbookArchives),
    data_store: ids(plan.dataStores),
    column: ids(plan.columns),
    view: ids(plan.views),
    row: ids(plan.rows),
    history: ids(plan.history),
    manager: ids(plan.managers),
    working_state: new Set(plan.workingStates.map((state) => state.managerId)),
    memory_file: new Set((plan.memories ?? []).flatMap((memory) => memory.files.map((file) => memoryFileIdOf({ managerId: memory.managerId, fileName: file.name })))),
  };
}

/** Counts what the last import wrote and the plan no longer holds. Nothing is deleted, and the ledger keeps the entries, so each run reports them again. */
export function reportRemovedInScape(input: { ledger: ImportLedger; plan: ImportPlan; report: ImportReport }): void {
  const plannedIds = plannedIdsByKind(input.plan);
  const isMemoryOutOfThisRun = input.plan.memories === undefined;
  for (const kind of LEDGER_KINDS) {
    if (kind === 'memory_file' && isMemoryOutOfThisRun) continue;
    const removedIds = input.ledger.idsOf(kind).filter((id) => !plannedIds[kind].has(id));
    input.report.counts[ENTITY_OF_LEDGER_KIND[kind]].removedInScape += removedIds.length;
  }
}
