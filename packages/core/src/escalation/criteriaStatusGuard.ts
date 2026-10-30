import type { DsColumn } from '@openfleet/shared';
import { log } from '../logger.js';
import { BACKLOG_TABLE } from '../managers/projectProfileTemplate.js';
import type { ManagerService } from '../managers/managerService.js';
import type { ProjectRepository } from '../projects/projectRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { ObservedRowWrite, RowWriteObserver } from '../stores/dataStoreService.js';
import type { AuditWriter } from './auditWriter.js';
import { escalationPolicyOf } from './projectPolicy.js';

export const ROW_GUARD_AUTHOR = 'daemon';

export interface CriteriaStatusGuardDeps {
  projects: Pick<ProjectRepository, 'get'>;
  managers: Pick<ManagerService, 'listViews'>;
  sessions: Pick<SessionService, 'get'>;
  audit: Pick<AuditWriter, 'journal'>;
}

const nameKey = (name: string): string => name.normalize('NFC').trim().toLowerCase();

const labelOfCell = (column: DsColumn, cell: unknown): string | undefined => {
  if (typeof cell !== 'string') return undefined;
  return column.columnType === 'select' ? column.options?.find((option) => option.id === cell)?.label : cell;
};

/**
 * Warn mode of the guard on the criteria_status column of the backlog: a write by anyone but the daemon that sets the approved option is allowed,
 * journaled in the journal of the managers of the project and counted. The writer cannot be verified yet, so nothing is refused.
 */
export class CriteriaStatusGuard implements RowWriteObserver {
  private warnings = 0;

  constructor(private readonly deps: CriteriaStatusGuardDeps) {}

  warningCount(): number {
    return this.warnings;
  }

  observeRowWrite({ projectId, storeName, columns, cells, actor, writtenByDaemon }: ObservedRowWrite): void {
    const isBacklog = nameKey(storeName) === nameKey(BACKLOG_TABLE.name);
    if (!isBacklog || writtenByDaemon) return;

    const policy = escalationPolicyOf(this.deps.projects, projectId);
    const criteriaColumn = columns.find((column) => nameKey(column.displayName) === nameKey(policy.criteriaStatusColumn));
    if (criteriaColumn === undefined) return;
    const writtenLabel = labelOfCell(criteriaColumn, cells[criteriaColumn.id]);
    const setsApproved = writtenLabel !== undefined && nameKey(writtenLabel) === nameKey(policy.approvedOption);
    if (!setsApproved) return;

    this.warnings += 1;
    const warning = `row guard (warn): ${actor.label} set ${criteriaColumn.displayName} to ${policy.approvedOption} on the backlog; only approve_plan_criteria should, the write is allowed`;
    log('warn', warning);
    this.journalToTheManagersOf(projectId, warning);
  }

  private journalToTheManagersOf(projectId: string, warning: string): void {
    const { managers, sessions, audit } = this.deps;
    const managersOfProject = managers.listViews().filter(({ sessionId }) => sessions.get(sessionId)?.projectId === projectId);
    for (const { sessionId } of managersOfProject) audit.journal({ managerId: sessionId, entries: [warning], author: ROW_GUARD_AUTHOR });
  }
}
