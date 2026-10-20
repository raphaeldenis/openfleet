import type { DatabaseSync } from 'node:sqlite';
import type { LawView } from '@openfleet/shared';
import { LawRepository } from '../../governance/lawRepository.js';
import { newId } from '../../ids.js';
import { countOutcome, type ImportReport } from './importReport.js';
import { hashOfValues, ImportLedger } from './scapeLedger.js';
import { LAW_IMPORT_MARK, type LawsPerManagerReport, type PlannedLaw } from './scapeLaws.js';
import type { ImportPlan } from './scapePlan.js';
import type { UpsertOutcome } from './scapeTarget.js';

const LAW_LEDGER_KIND = 'law';

const hashOfSourceText = (law: PlannedLaw) => hashOfValues({ text: law.sourceText });

const hasManagerRow = (db: DatabaseSync, managerId: string) => db.prepare('SELECT 1 FROM managers WHERE session_id = ?').get(managerId) !== undefined;

/** A withdrawn law, or one whose last author is not the import, was decided by a human: the import leaves it alone. */
const isDecidedLocally = (stored: LawView) => stored.status === 'withdrawn' || stored.updatedBy !== LAW_IMPORT_MARK;

interface LawWriteContext { laws: LawRepository; ledger: ImportLedger; db: DatabaseSync }

function insertLaw(context: LawWriteContext, law: PlannedLaw): UpsertOutcome {
  if (!hasManagerRow(context.db, law.argusId)) return 'conflict';
  context.laws.insertFromImport({ id: newId(), managerId: law.argusId, text: law.text, sourceKey: law.key, importedBy: LAW_IMPORT_MARK, createdAt: law.createdAt, sourceCreatedAt: law.sourceCreatedAt });
  context.ledger.remember({ kind: LAW_LEDGER_KIND, id: law.key, hash: hashOfSourceText(law) });
  return 'written';
}

function reconcileStoredLaw(context: LawWriteContext, law: PlannedLaw, stored: LawView): UpsertOutcome {
  if (isDecidedLocally(stored)) return 'conflict';
  const hash = hashOfSourceText(law);
  const isAsImported = stored.text === law.text;
  if (isAsImported) {
    context.ledger.remember({ kind: LAW_LEDGER_KIND, id: law.key, hash });
    return 'alreadyPresent';
  }
  context.laws.replaceTextFromImport({ lawId: stored.id, text: law.text, importedBy: LAW_IMPORT_MARK, updatedAt: new Date().toISOString() });
  context.ledger.remember({ kind: LAW_LEDGER_KIND, id: law.key, hash });
  return 'updated';
}

function writeLaw(context: LawWriteContext, law: PlannedLaw): UpsertOutcome {
  const stored = context.laws.findBySourceKey(law.key);
  if (stored !== undefined) return reconcileStoredLaw(context, law, stored);
  const isDeletedInOpenFleet = context.ledger.hashOf(LAW_LEDGER_KIND, law.key) !== undefined;
  return isDeletedInOpenFleet ? 'deletedInOpenFleet' : insertLaw(context, law);
}

function perManagerReportOf(argusId: string, report: ImportReport): LawsPerManagerReport {
  const existing = report.laws.perManager.find((entry) => entry.argus === argusId);
  if (existing !== undefined) return existing;
  const created = { argus: argusId, approved: 0, inserted: 0, updated: 0, conflict: 0, alreadyPresent: 0 };
  report.laws.perManager.push(created);
  return created;
}

function addToPerManagerReport(entry: LawsPerManagerReport, outcome: UpsertOutcome): void {
  entry.approved++;
  if (outcome === 'written') entry.inserted++;
  else if (outcome === 'updated') entry.updated++;
  else if (outcome === 'alreadyPresent') entry.alreadyPresent++;
  else entry.conflict++;
}

/** Writes the planned Scape laws into the laws table: absent → inserted, changed in Scape and intact → text replaced, edited, withdrawn or deleted in OpenFleet → left as it is. */
export function writeLaws(db: DatabaseSync, plan: ImportPlan, report: ImportReport): void {
  const context: LawWriteContext = { db, laws: new LawRepository(db), ledger: new ImportLedger(db) };
  const counts = report.counts.laws;
  for (const law of plan.laws) {
    const outcome = writeLaw(context, law);
    counts.expected++;
    countOutcome(counts, outcome);
    addToPerManagerReport(perManagerReportOf(law.argusId, report), outcome);
  }
  counts.expected += plan.lawsReport.invalidText;
  counts.notConverted += plan.lawsReport.invalidText;
}
