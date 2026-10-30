import type { DatabaseSync } from 'node:sqlite';
import { MANAGER_ROLE } from '@openfleet/shared';
import { newToken } from '../../ids.js';
import { inTransaction } from '../../db/transaction.js';
import { ManagerRepository } from '../../managers/managerRepository.js';
import { SessionRepository } from '../../sessions/sessionRepository.js';
import { addManagerFinding, countOutcome, type ImportReport } from './importReport.js';
import { ImportLedger } from './scapeLedger.js';
import type { ImportPlan } from './scapePlan.js';
import type { PlannedManager } from './scapeManagers.js';
import { reconcileRecord, type RecordValues, type UpsertOutcome } from './scapeTarget.js';

const MANAGER_EMOJI = '🤖';
const STORED_MANAGER_STATE = 'closed';
const MANAGER_OUTCOMES_THAT_STORE_THE_PLANNED_MODEL: UpsertOutcome[] = ['written', 'updated'];

export interface Repositories { sessions: SessionRepository; managers: ManagerRepository }

function insertManager(db: DatabaseSync, repositories: Repositories, planned: PlannedManager): void {
  const { session, manager } = planned;
  const hookToken = newToken();
  const mcpToken = newToken();
  inTransaction(db, 'importScapeManagerInsert', () => {
    repositories.sessions.insert({
      id: planned.id, name: session.name, emoji: MANAGER_EMOJI, directory: session.directory, worktree: null, model: session.model,
      parent_id: null, role: MANAGER_ROLE, harness: session.harness, state: STORED_MANAGER_STATE, state_since: session.createdAt,
      hook_token: hookToken, mcp_token: mcpToken, permission_mode: null, branch: null, project_id: session.projectId, created_at: session.createdAt,
    });
    repositories.sessions.setClosed(planned.id, undefined, session.createdAt, hookToken, mcpToken);
    repositories.managers.insert({
      sessionId: planned.id, pulseSeconds: manager.pulseSeconds, childrenCap: manager.childrenCap, missionText: manager.missionText, createdAt: session.createdAt,
    });
  });
}

/** What the import owns of a manager: its mission, pulse, cap and model. A start or a pulse since the import changes none of them. */
const ownedValuesOf = (input: { missionText: string; pulseSeconds: number; childrenCap: number; model: string | null }): RecordValues => ({
  mission_text: input.missionText, pulse_seconds: input.pulseSeconds, children_cap: input.childrenCap, model: input.model,
});

function plannedValuesOf(planned: PlannedManager): RecordValues {
  return ownedValuesOf({ ...planned.manager, model: planned.session.model });
}

export function storedValuesOf(repositories: Repositories, id: string): RecordValues | undefined {
  const storedSession = repositories.sessions.get(id);
  const storedManager = repositories.managers.get(id);
  const isTheImportedManager = storedSession?.role === MANAGER_ROLE && storedManager !== undefined;
  return isTheImportedManager ? ownedValuesOf({ ...storedManager, model: storedSession.model ?? null }) : undefined;
}

export function hasLocalProfileFields(managers: ManagerRepository, id: string): boolean {
  const manager = managers.get(id);
  const hasExpertise = (manager?.expertise ?? '') !== '';
  const hasPulseActions = (manager?.pulseActions ?? []).length > 0;
  return hasExpertise || hasPulseActions;
}

function updateManager(db: DatabaseSync, planned: PlannedManager): void {
  const { manager, session } = planned;
  db.prepare('UPDATE managers SET mission_text = ?, pulse_seconds = ?, children_cap = ?, profile_rev = profile_rev + 1 WHERE session_id = ?').run(manager.missionText, manager.pulseSeconds, manager.childrenCap, planned.id);
  db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(session.model, planned.id);
}

function writeManager(input: { db: DatabaseSync; ledger: ImportLedger; repositories: Repositories; planned: PlannedManager }): UpsertOutcome {
  const { db, ledger, repositories, planned } = input;
  const isSessionOfAnotherKind = repositories.sessions.get(planned.id) !== undefined && storedValuesOf(repositories, planned.id) === undefined;
  if (isSessionOfAnotherKind) return 'conflict';
  return reconcileRecord({
    ledger, kind: 'manager', id: planned.id, planned: plannedValuesOf(planned),
    policy: { canUpdate: () => !hasLocalProfileFields(repositories.managers, planned.id) },
    gateway: {
      readStored: () => storedValuesOf(repositories, planned.id),
      insert: () => insertManager(db, repositories, planned),
      update: () => updateManager(db, planned),
    },
  });
}

function addToolReferencesToReport(report: ImportReport, planned: PlannedManager): void {
  const { renamedCount, playbookPointerCount, unmappedToolNames } = planned.toolReferences;
  const references = report.missionToolReferences;
  references.renamed += renamedCount;
  references.pointedAtPlaybookShims += playbookPointerCount;
  for (const toolName of unmappedToolNames) references.withoutEquivalent[toolName] = (references.withoutEquivalent[toolName] ?? 0) + 1;
}

/** Writes each planned manager as a closed manager session plus its managers row, through the session and manager repositories. A stored manager that OpenFleet changed is left as it is. */
export function writeManagers(db: DatabaseSync, plan: ImportPlan, report: ImportReport): Map<string, UpsertOutcome> {
  const repositories: Repositories = { sessions: new SessionRepository(db), managers: new ManagerRepository(db) };
  const ledger = new ImportLedger(db);
  const counts = report.counts.managers;
  const outcomes = new Map<string, UpsertOutcome>();
  for (const planned of plan.managers) {
    const outcome = writeManager({ db, ledger, repositories, planned });
    outcomes.set(planned.id, outcome);
    counts.expected++;
    countOutcome(counts, outcome);
    if (planned.isNotFullyConverted) counts.notConverted++;
    const isDefaultStoredByThisRun = planned.isModelDefaulted && MANAGER_OUTCOMES_THAT_STORE_THE_PLANNED_MODEL.includes(outcome);
    const hasModelFindingToReport = planned.modelFinding !== undefined && (!planned.isModelDefaulted || isDefaultStoredByThisRun);
    if (hasModelFindingToReport) addManagerFinding(report, { managerName: planned.session.name, text: planned.modelFinding! });
    report.pendingPlaybookMentions += planned.pendingPlaybookMentionCount;
    addToolReferencesToReport(report, planned);
  }
  counts.expected += plan.skippedManagerCount;
  counts.notConverted += plan.skippedManagerCount;
  return outcomes;
}
