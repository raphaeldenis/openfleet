import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/transaction.js';
import type { GovernanceQueueService } from '../governance/governanceQueueService.js';
import type { NoteService } from '../notes/noteService.js';
import type { DataStoreRepository } from '../stores/dataStoreRepository.js';
import type { DataStoreService } from '../stores/dataStoreService.js';
import type { ManagerService } from './managerService.js';
import { MISSION_NOTE_BODY, missionNoteTitleOf, PROFILE_TABLES, TABLE_ACCESS_REQUEST, JOURNAL_TABLE, type TableTemplate } from './projectProfileTemplate.js';

export interface ProjectProfileBootstrapDeps {
  db: DatabaseSync;
  stores: Pick<DataStoreService, 'createStore' | 'addColumn' | 'setNaturalKey'>;
  storeRepo: Pick<DataStoreRepository, 'findStoreByName'>;
  notes: Pick<NoteService, 'create'>;
  managers: Pick<ManagerService, 'get' | 'update' | 'bindLogStore'>;
  governanceQueue: Pick<GovernanceQueueService, 'requestResourceAccess' | 'viewOf'>;
}

export interface BootstrapInput {
  managerId: string;
  managerName: string;
  projectId: string;
  /** Who the mission note names as its author. */
  author: string;
}

export interface TableOutcome { name: string; id: string; created: boolean }
export interface GrantRequestOutcome { resourceId: string; requestId?: string; status: 'pending' | 'queued' | 'granted'; filed: boolean }

export interface ProfileSkeletonReport {
  managerId: string;
  projectId: string;
  tables: TableOutcome[];
  missionNote: { id: string; created: boolean };
  logStoreId: string;
  grantRequests: GrantRequestOutcome[];
}

/**
 * Gives a manager the skeleton of its project in one transaction: the tables, the mission note, the log binding and the
 * access requests. Whatever exists is reused, so a second run writes nothing. It never changes a pulse and grants nothing.
 */
export class ProjectProfileBootstrap {
  constructor(private readonly deps: ProjectProfileBootstrapDeps) {}

  bootstrap(input: BootstrapInput): ProfileSkeletonReport {
    return inTransaction(this.deps.db, 'project_profile_bootstrap', () => {
      const { managerId, projectId } = input;
      const tables = PROFILE_TABLES.map((template) => this.ensureTable({ projectId, template }));
      const missionNote = this.ensureMissionNote(input);
      const logStoreId = this.ensureLogStore({ managerId, journalId: tables.find((table) => table.name === JOURNAL_TABLE.name)!.id });
      const grantRequests = tables.map((table) => this.requestAccessTo({ managerId, resourceId: table.id }));
      return { managerId, projectId, tables, missionNote, logStoreId, grantRequests };
    });
  }

  private ensureTable({ projectId, template }: { projectId: string; template: TableTemplate }): TableOutcome {
    const existing = this.deps.storeRepo.findStoreByName(projectId, template.name);
    if (existing) return { name: template.name, id: existing.id, created: false };

    const store = this.deps.stores.createStore({ projectId, displayName: template.name });
    for (const { displayName, columnType, format, autoValue, isNaturalKey } of template.columns) {
      const column = this.deps.stores.addColumn(store.id, { projectId, displayName, columnType, format, autoValue });
      if (isNaturalKey) this.deps.stores.setNaturalKey(store.id, { projectId, columnId: column.id });
    }
    return { name: template.name, id: store.id, created: true };
  }

  private ensureMissionNote({ managerId, managerName, projectId, author }: BootstrapInput): { id: string; created: boolean } {
    const linkedNoteId = this.deps.managers.get(managerId)?.missionNoteId;
    if (linkedNoteId) return { id: linkedNoteId, created: false };

    const note = this.deps.notes.create({ projectId, title: missionNoteTitleOf(managerName), bodyMd: MISSION_NOTE_BODY, author });
    this.deps.managers.update(managerId, { missionNoteId: note.id });
    return { id: note.id, created: true };
  }

  private ensureLogStore({ managerId, journalId }: { managerId: string; journalId: string }): string {
    const boundStoreId = this.deps.managers.get(managerId)?.logStoreId;
    if (boundStoreId) return boundStoreId;

    this.deps.managers.bindLogStore(managerId, journalId);
    return journalId;
  }

  private requestAccessTo({ managerId, resourceId }: { managerId: string; resourceId: string }): GrantRequestOutcome {
    const isAlreadyGranted = this.deps.governanceQueue.viewOf(managerId).resourceGrants.some((grant) => grant.resourceType === 'dataStore' && grant.resourceId === resourceId);
    if (isAlreadyGranted) return { resourceId, status: 'granted', filed: false };

    const filed = this.deps.governanceQueue.requestResourceAccess({
      managerId, resourceType: 'dataStore', resourceId, ...TABLE_ACCESS_REQUEST, incident: 'project profile skeleton',
    });
    return { resourceId, requestId: filed.proposal.id, status: filed.status, filed: !filed.deduplicated };
  }
}
