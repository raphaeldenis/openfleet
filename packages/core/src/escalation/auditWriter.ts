import type { EscalatingClass, ReproClaim } from '@openfleet/shared';
import { log } from '../logger.js';
import type { ManagerService } from '../managers/managerService.js';
import type { NoteRepository } from '../notes/noteRepository.js';
import type { NoteService } from '../notes/noteService.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { DataStoreRepository } from '../stores/dataStoreRepository.js';
import type { DataStoreService } from '../stores/dataStoreService.js';
import type { StoredBatch } from './escalationRepository.js';

export const ARBITER_AUTHOR = 'arbiter';
export const JOURNAL_NOT_BOUND_WARNING = 'journal_not_bound';
export const JOURNAL_WRITE_FAILED_WARNING = 'journal_write_failed';
export const PLAN_NOTE_UNAVAILABLE_WARNING = 'plan_note_unavailable';

const JOURNAL_TEXT_COLUMN_NAMES = ['journal', 'entry'];
const AUTHOR_COLUMN_NAME = 'author';

export interface AuditedDecision {
  questionId: string;
  questionText: string;
  verdict: 'decided' | 'needs_human';
  decision: string;
  rationale: string;
  raiseTo?: EscalatingClass;
  evidence?: ReproClaim;
}

export interface AuditWriterDeps {
  notes: Pick<NoteService, 'append'>;
  noteRepo: Pick<NoteRepository, 'get'>;
  managers: Pick<ManagerService, 'get' | 'isMissionNote'>;
  sessions: Pick<SessionService, 'get' | 'sendMessage'>;
  stores: Pick<DataStoreService, 'insertRows'>;
  storeRepo: Pick<DataStoreRepository, 'listColumns'>;
}

const nameOf = (column: { displayName: string }) => column.displayName.normalize('NFC').trim().toLowerCase();

const sectionContentOf = ({ batch, arbiterSessionId, decision, auditedRev }: { batch: StoredBatch; arbiterSessionId: string; decision: AuditedDecision; auditedRev: number }): string => {
  const raisedTo = decision.raiseTo && `Raised to: ${decision.raiseTo}`;
  const evidence = decision.evidence && `Evidence (${decision.evidence.status}): ${decision.evidence.claim}${decision.evidence.command ? ` — ${decision.evidence.command}` : ''}`;
  return [
    `Ticket: ${batch.ticket} · audited revision of this note: ${auditedRev} · arbiter session: ${arbiterSessionId}`,
    `Question: ${decision.questionText}`,
    `Verdict: ${decision.verdict}`,
    `Decision: ${decision.decision}`,
    `Rationale: ${decision.rationale}`,
    raisedTo, evidence,
  ].filter((line): line is string => Boolean(line)).join('\n\n');
};

/** Writes what the daemon records on behalf of the arbiter: sections of the plan note, lines of the manager journal, lines to the manager. None of them throws. */
export class AuditWriter {
  constructor(private readonly deps: AuditWriterDeps) {}

  /** Appends one section per decision to the plan note, never to the mission note; answers the revision of the note after the writes and the warnings. */
  appendDecisionSections({ batch, arbiterSessionId, decisions }: { batch: StoredBatch; arbiterSessionId: string; decisions: readonly AuditedDecision[] }): { planNoteRev: number; warnings: string[] } {
    const { notes, noteRepo, managers } = this.deps;
    const isMissionNote = managers.isMissionNote(batch.planNoteId);
    const auditedRev = noteRepo.get(batch.planNoteId)?.rev;
    if (isMissionNote || auditedRev === undefined) return { planNoteRev: batch.planNoteRev, warnings: [PLAN_NOTE_UNAVAILABLE_WARNING] };

    try {
      for (const decision of decisions) {
        notes.append(batch.planNoteId, { heading: `Arbiter decision ${batch.id} ${decision.questionId}`, content: sectionContentOf({ batch, arbiterSessionId, decision, auditedRev }), author: ARBITER_AUTHOR });
      }
    } catch (error) {
      log('warn', `arbiter audit: the plan note ${batch.planNoteId} could not take the decisions of batch ${batch.id}`, error);
      return { planNoteRev: noteRepo.get(batch.planNoteId)?.rev ?? batch.planNoteRev, warnings: [PLAN_NOTE_UNAVAILABLE_WARNING] };
    }
    return { planNoteRev: noteRepo.get(batch.planNoteId)?.rev ?? batch.planNoteRev, warnings: [] };
  }

  /** Adds one line per entry to the journal the manager is bound to; the author column holds `arbiter` when the table has one, else the text opens with `[arbiter]`. Answers the warnings. */
  journal({ managerId, entries, author = ARBITER_AUTHOR }: { managerId: string; entries: readonly string[]; author?: string }): string[] {
    const { managers, sessions, stores, storeRepo } = this.deps;
    const logStoreId = managers.get(managerId)?.logStoreId;
    const projectId = sessions.get(managerId)?.projectId;
    if (logStoreId === undefined || projectId === undefined) return [JOURNAL_NOT_BOUND_WARNING];

    try {
      const columns = storeRepo.listColumns(logStoreId);
      const textColumn = columns.find((column) => column.columnType === 'text' && JOURNAL_TEXT_COLUMN_NAMES.includes(nameOf(column)));
      if (textColumn === undefined) return [JOURNAL_NOT_BOUND_WARNING];
      const authorColumn = columns.find((column) => column.columnType === 'text' && nameOf(column) === AUTHOR_COLUMN_NAME);
      const items = entries.map((entry) => ({
        [textColumn.id]: authorColumn ? entry : `[${author}] ${entry}`,
        ...(authorColumn && { [authorColumn.id]: author }),
      }));
      stores.insertRows(logStoreId, { projectId, items, actor: { kind: 'agent', label: author } });
      return [];
    } catch (error) {
      log('warn', `arbiter audit: the journal of manager ${managerId} could not take ${entries.length} line(s)`, error);
      return [JOURNAL_WRITE_FAILED_WARNING];
    }
  }

  tellManager({ managerId, body, fromSessionId }: { managerId: string; body: string; fromSessionId?: string }): void {
    try {
      this.deps.sessions.sendMessage({ sessionId: managerId, body, ...(fromSessionId !== undefined && { fromSessionId }) });
    } catch (error) {
      log('warn', `arbiter audit: manager ${managerId} could not be told`, error);
    }
  }
}
