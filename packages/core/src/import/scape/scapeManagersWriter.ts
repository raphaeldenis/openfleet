import type { DatabaseSync } from 'node:sqlite';
import { MANAGER_ROLE } from '@openfleet/shared';
import { newToken } from '../../ids.js';
import { inTransaction } from '../../db/transaction.js';
import { ManagerRepository } from '../../managers/managerRepository.js';
import { SessionRepository } from '../../sessions/sessionRepository.js';
import type { ImportReport } from './importReport.js';
import type { ImportPlan } from './scapePlan.js';
import type { PlannedManager } from './scapeManagers.js';
import type { UpsertOutcome } from './scapeTarget.js';

const MANAGER_EMOJI = '🤖';
const STORED_MANAGER_STATE = 'closed';

interface Repositories { sessions: SessionRepository; managers: ManagerRepository }

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

/** What the import owns of a stored manager: its mission, pulse, cap and model. A start or a pulse since the import changes none of them. */
function isStoredAsPlanned(repositories: Repositories, planned: PlannedManager): boolean {
  const storedSession = repositories.sessions.get(planned.id);
  const storedManager = repositories.managers.get(planned.id);
  const isTheImportedManager = storedSession?.role === MANAGER_ROLE && storedManager !== undefined;
  if (!isTheImportedManager) return false;

  const { manager, session } = planned;
  return storedManager.missionText === manager.missionText
    && storedManager.pulseSeconds === manager.pulseSeconds
    && storedManager.childrenCap === manager.childrenCap
    && (storedSession.model ?? null) === session.model;
}

function writeManager(db: DatabaseSync, repositories: Repositories, planned: PlannedManager): UpsertOutcome {
  const isAbsent = repositories.sessions.get(planned.id) === undefined;
  if (isAbsent) {
    insertManager(db, repositories, planned);
    return 'written';
  }
  return isStoredAsPlanned(repositories, planned) ? 'alreadyPresent' : 'conflict';
}

/** Writes each planned manager as a closed manager session plus its managers row, through the session and manager repositories. A stored manager that differs is left as it is. */
export function writeManagers(db: DatabaseSync, plan: ImportPlan, report: ImportReport): Map<string, UpsertOutcome> {
  const repositories: Repositories = { sessions: new SessionRepository(db), managers: new ManagerRepository(db) };
  const counts = report.counts.managers;
  const outcomes = new Map<string, UpsertOutcome>();
  for (const planned of plan.managers) {
    const outcome = writeManager(db, repositories, planned);
    outcomes.set(planned.id, outcome);
    counts.expected++;
    counts[outcome]++;
    if (planned.isNotFullyConverted) counts.notConverted++;
    report.pendingPlaybookMentions += planned.pendingPlaybookMentionCount;
  }
  counts.expected += plan.skippedManagerCount;
  counts.notConverted += plan.skippedManagerCount;
  return outcomes;
}
