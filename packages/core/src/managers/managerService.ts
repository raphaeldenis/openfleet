import { MANAGER_ROLE, type ManagerProfile, type ManagerSpec, type ManagerView, type ScapeImportStatus, type Session, type SessionSpec, type UpdateManager } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import { NoteNotFoundError } from '../notes/noteService.js';
import type { SessionService } from '../sessions/sessionService.js';
import { StoreNotFoundError } from '../stores/dataStoreRepository.js';
import { isPulseEnabled, type ManagerRecord, type ManagerRepository } from './managerRepository.js';
import { DEFAULT_HEARTBEAT_SECONDS } from '../workingState/workingStateSettings.js';
import { toManagerView, type DeniedCommandCounts } from './managerView.js';

export interface PulseSchedulerLike {
  onManagerCreated(record: ManagerRecord): void;
  onManagerUpdated(record: ManagerRecord): void;
  /** The manager was paused or resumed: `record.pulseEnabled` tells which. */
  onPulseEnabledChanged(record: ManagerRecord): void;
}

/** Tells which project owns a note or a table; undefined for an id that does not exist. */
export interface ManagerLinkTargets {
  noteProjectId(noteId: string): string | undefined;
  storeProjectId(storeId: string): string | undefined;
}

export interface ManagerServiceDeps {
  managers: ManagerRepository;
  sessions: SessionService;
  bus: EventBus;
  scheduler: PulseSchedulerLike;
  /** Absent, every note and table reads as missing: nothing can be linked. */
  linkTargets?: ManagerLinkTargets;
  heartbeatDefaultSeconds?: number;
  /** Absent, no manager counts as imported. */
  scapeImportStatusOf?: (sessionId: string) => ScapeImportStatus;
  /** Absent, no manager has any refused command. */
  deniedCommandCountsOf?: (managerId: string) => DeniedCommandCounts;
}

export class ManagerService {
  private readonly deps: ManagerServiceDeps;

  constructor(deps: ManagerServiceDeps) {
    this.deps = deps;
  }

  async createManagerSession(spec: SessionSpec & { manager: ManagerSpec; repoPath?: string; branchName?: string }): Promise<Session> {
    const managerSpec = { ...spec, role: MANAGER_ROLE, seededPrompt: spec.seededPrompt ?? spec.manager.mission };
    const hasRepo = spec.repoPath !== undefined && spec.branchName !== undefined;
    const session = hasRepo
      ? await this.deps.sessions.createInWorktree({ ...managerSpec, repoPath: spec.repoPath!, branchName: spec.branchName! })
      : await this.deps.sessions.create(managerSpec);
    const record: ManagerRecord = {
      sessionId: session.id,
      pulseSeconds: spec.manager.pulseSeconds ?? this.deps.heartbeatDefaultSeconds ?? DEFAULT_HEARTBEAT_SECONDS,
      childrenCap: spec.manager.childrenCap,
      missionText: spec.manager.mission,
      createdAt: session.createdAt,
    };
    this.deps.managers.insert(record);
    this.deps.bus.emit({ type: 'manager.created', manager: this.view(record) });
    this.deps.scheduler.onManagerCreated(record);
    return session;
  }

  get(sessionId: string): ManagerRecord | undefined {
    return this.deps.managers.get(sessionId);
  }

  /**
   * Changes the pulse, cap, mission, model, mission note, its pin or the pause of a manager; undefined when the session has no manager row.
   * Throws NoteNotFoundError, before changing anything, for a mission note outside the manager's project.
   */
  update(sessionId: string, patch: UpdateManager): ManagerView | undefined {
    if (!this.deps.managers.get(sessionId)) return undefined;
    const { mission, model, missionNoteId, pinMissionNote, pulseEnabled, ...cadenceAndCap } = patch;
    const isLinkingNote = typeof missionNoteId === 'string';
    if (isLinkingNote) this.requireNoteOfManagerProject({ managerId: sessionId, noteId: missionNoteId });
    if (model !== undefined) this.deps.sessions.changeModel(sessionId, model);
    this.deps.managers.update(sessionId, { ...cadenceAndCap, missionText: mission });
    if (missionNoteId !== undefined) this.deps.managers.setMissionNote(sessionId, missionNoteId);
    if (pinMissionNote !== undefined) this.deps.managers.setMissionNotePinned(sessionId, pinMissionNote);
    const wasPulseEnabled = isPulseEnabled(this.deps.managers.get(sessionId)!);
    if (pulseEnabled !== undefined) this.deps.managers.setPulseEnabled(sessionId, pulseEnabled);
    const updated = this.deps.managers.get(sessionId)!;
    const view = this.announceUpdated(updated);
    this.deps.scheduler.onManagerUpdated(updated);
    const isPulseEnabledChanged = pulseEnabled !== undefined && pulseEnabled !== wasPulseEnabled;
    if (isPulseEnabledChanged) this.deps.scheduler.onPulseEnabledChanged(updated);
    return view;
  }

  /**
   * Binds the table the manager logs its actions in; undefined when the session has no manager row.
   * Throws StoreNotFoundError for a table outside the manager's project.
   */
  bindLogStore(sessionId: string, storeId: string): ManagerView | undefined {
    if (!this.deps.managers.get(sessionId)) return undefined;
    this.requireStoreOfManagerProject({ managerId: sessionId, storeId });
    this.deps.managers.setLogStore(sessionId, storeId);
    return this.announceUpdated(this.deps.managers.get(sessionId)!);
  }

  /** The manager as the profile page shows it: its view, and where it stands against a Scape re-import. */
  profile(sessionId: string): ManagerProfile | undefined {
    const record = this.deps.managers.get(sessionId);
    if (!record) return undefined;
    const scapeImport = this.deps.scapeImportStatusOf?.(sessionId) ?? 'not_imported';
    return { manager: this.view(record), scapeImport };
  }

  listViews(): ManagerView[] {
    return this.deps.managers.list().map((record) => this.view(record));
  }

  private requireNoteOfManagerProject({ managerId, noteId }: { managerId: string; noteId: string }): void {
    const noteProjectId = this.deps.linkTargets?.noteProjectId(noteId);
    if (!this.isInProjectOfManager({ managerId, projectId: noteProjectId })) throw new NoteNotFoundError(noteId);
  }

  private requireStoreOfManagerProject({ managerId, storeId }: { managerId: string; storeId: string }): void {
    const storeProjectId = this.deps.linkTargets?.storeProjectId(storeId);
    if (!this.isInProjectOfManager({ managerId, projectId: storeProjectId })) throw new StoreNotFoundError(storeId);
  }

  private isInProjectOfManager({ managerId, projectId }: { managerId: string; projectId: string | undefined }): boolean {
    const managerProjectId = this.deps.sessions.get(managerId)?.projectId;
    const hasKnownOwner = projectId !== undefined && managerProjectId !== undefined;
    return hasKnownOwner && projectId === managerProjectId;
  }

  private announceUpdated(record: ManagerRecord): ManagerView {
    const view = this.view(record);
    this.deps.bus.emit({ type: 'manager.updated', manager: view });
    return view;
  }

  private view(record: ManagerRecord): ManagerView {
    const childrenCount = this.deps.sessions.list().filter((s) => s.parentId === record.sessionId && s.state !== 'closed').length;
    return toManagerView(record, childrenCount, this.deps.deniedCommandCountsOf?.(record.sessionId));
  }
}
