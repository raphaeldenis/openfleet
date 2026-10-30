import { OpenFleetError, type EscalationPolicy } from '@openfleet/shared';
import type { DsColumn, DsRow } from '@openfleet/shared';
import type { NoteRepository } from '../notes/noteRepository.js';
import { BACKLOG_TABLE } from '../managers/projectProfileTemplate.js';
import { AmbiguousNaturalKeyError, NoNaturalKeyError, type DataStoreService } from '../stores/dataStoreService.js';
import { RowNotFoundError, type DataStoreRepository } from '../stores/dataStoreRepository.js';
import { ARBITER_AUTHOR, type AuditWriter } from './auditWriter.js';
import type { EscalationRepository, StoredBatch } from './escalationRepository.js';

export interface CriteriaApprovalDeps {
  repository: Pick<EscalationRepository, 'batchesOfTicket' | 'questionsOfBatch' | 'decisionsOfBatch'>;
  noteRepo: Pick<NoteRepository, 'get'>;
  stores: Pick<DataStoreService, 'findRowByNaturalKey' | 'updateRow'>;
  storeRepo: Pick<DataStoreRepository, 'findStoreByName' | 'listColumns'>;
  audit: Pick<AuditWriter, 'journal'>;
}

export interface ApprovedCriteria {
  opinionId: string;
  warnings: string[];
}

const nameKey = (name: string): string => name.normalize('NFC').trim().toLowerCase();

/** The note revision the arbiter audited when it gave this batch its opinion: the revision after the daemon's own appends. */
const auditedRevisionOf = (decisions: readonly { planNoteRev: number }[], batch: StoredBatch): number =>
  decisions.reduce((latest, { planNoteRev }) => Math.max(latest, planNoteRev), batch.planNoteRev);

/** Approves the criteria of a ticket on behalf of the arbiter: checks the opinion, then the daemon itself writes the backlog column and the journal. */
export class CriteriaApproval {
  constructor(private readonly deps: CriteriaApprovalDeps) {}

  approve({ managerId, projectId, ticket, planNoteId, policy }: { managerId: string; projectId: string; ticket: string; planNoteId: string; policy: EscalationPolicy }): ApprovedCriteria {
    const batch = this.favourableBatchOnCurrentRevision({ managerId, ticket, planNoteId });
    const target = this.backlogCellOf({ projectId, ticket, policy });
    const isAlreadyApproved = target.row.data[target.column.id] === target.approvedCell;
    if (isAlreadyApproved) return { opinionId: batch.id, warnings: [] };

    this.deps.stores.updateRow(target.storeId, target.row.id, {
      projectId, patch: { [target.column.id]: target.approvedCell }, actor: { kind: 'agent', label: ARBITER_AUTHOR }, writtenByDaemon: true,
    });
    const warnings = this.deps.audit.journal({ managerId, entries: [`${ticket} criteria approved (opinion ${batch.id})`] });
    return { opinionId: batch.id, warnings };
  }

  private favourableBatchOnCurrentRevision({ managerId, ticket, planNoteId }: { managerId: string; ticket: string; planNoteId: string }): StoredBatch {
    const { repository, noteRepo } = this.deps;
    const batches = repository.batchesOfTicket({ managerId, ticket });
    const hasNoBatch = batches.length === 0;
    if (hasNoBatch) throw new OpenFleetError('escalation_not_found', `no plan questions were submitted on ${ticket}`, { hint: 'Submit the questions of the plan with submit_plan_questions first.' });

    const questions = batches.flatMap((batch) => repository.questionsOfBatch(batch.id));
    const isWaitingForAHuman = questions.some((question) => question.status === 'pending_human');
    if (isWaitingForAHuman) throw new OpenFleetError('escalation_open', `the escalation of ${ticket} is still open: a human has not answered`, { hint: 'Approve the criteria once the human answered.' });
    const isWaitingForTheArbiter = questions.some((question) => question.status === 'open');
    if (isWaitingForTheArbiter) throw new OpenFleetError('criteria_stale', `a batch of ${ticket} still waits for its arbiter`, { hint: 'Approve the criteria once the arbiter reported.' });

    const currentRev = noteRepo.get(planNoteId)?.rev;
    const favourableBatches = batches.filter((batch) => batch.planNoteId === planNoteId && batch.criteriaOpinion?.opinion === 'favourable');
    if (favourableBatches.length === 0) throw new OpenFleetError('criteria_stale', `no favourable arbiter opinion on the criteria of ${ticket} for this plan note`, { hint: 'Submit the open points with submit_plan_questions to get a favourable opinion.' });

    const onCurrentRevision = favourableBatches.filter((batch) => auditedRevisionOf(repository.decisionsOfBatch(batch.id), batch) === currentRev);
    const latest = onCurrentRevision.at(-1);
    if (latest === undefined) throw new OpenFleetError('criteria_stale', `the plan note changed after the favourable arbiter opinion on ${ticket}`, { hint: 'Submit your follow-up questions with submit_plan_questions to get a new opinion on the current note.' });
    return latest;
  }

  private backlogCellOf({ projectId, ticket, policy }: { projectId: string; ticket: string; policy: EscalationPolicy }): { storeId: string; row: DsRow; column: DsColumn; approvedCell: string } {
    const { stores, storeRepo } = this.deps;
    const backlog = storeRepo.findStoreByName(projectId, BACKLOG_TABLE.name);
    if (backlog === undefined) throw new OpenFleetError('invalid_body', `the project has no "${BACKLOG_TABLE.name}" table`, { hint: 'Run bootstrap_project_profile to create it.' });

    const columns = storeRepo.listColumns(backlog.id);
    const column = columns.find((candidate) => nameKey(candidate.displayName) === nameKey(policy.criteriaStatusColumn));
    if (column === undefined) throw new OpenFleetError('invalid_body', `the backlog has no ${policy.criteriaStatusColumn} column`, { hint: `Add a ${policy.criteriaStatusColumn} column to the backlog table.` });

    const approvedOption = column.options?.find((option) => nameKey(option.label) === nameKey(policy.approvedOption));
    const isSelect = column.columnType === 'select';
    if (isSelect && approvedOption === undefined) throw new OpenFleetError('invalid_body', `the ${column.displayName} column has no ${policy.approvedOption} option`, { hint: `Add the option ${policy.approvedOption} to the column.` });
    if (!isSelect && column.columnType !== 'text') throw new OpenFleetError('invalid_body', `the ${column.displayName} column must be a select or a text column`);

    try {
      const row = stores.findRowByNaturalKey(backlog.id, { projectId, key: ticket });
      return { storeId: backlog.id, row, column, approvedCell: isSelect ? approvedOption!.id : policy.approvedOption };
    } catch (error) {
      const isMissingRow = error instanceof RowNotFoundError || error instanceof NoNaturalKeyError || error instanceof AmbiguousNaturalKeyError;
      if (!isMissingRow) throw error;
      throw new OpenFleetError('invalid_body', `the backlog has no single row for ${ticket}`, { hint: 'Add the ticket to the Ticket column of the backlog.' });
    }
  }
}
