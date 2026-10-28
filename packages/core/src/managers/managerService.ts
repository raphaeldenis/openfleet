import { isMissionWritable, MANAGER_ROLE, MAX_MISSION_DELTA_BYTES, OpenFleetError, UpdateManagerSchema, type ManagerProfile, type ManagerSpec, type ManagerView, type ScapeImportStatus, type Session, type SessionSpec, type UpdateManager } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import { NoteNotFoundError } from '../notes/noteService.js';
import type { SessionService } from '../sessions/sessionService.js';
import { StoreNotFoundError } from '../stores/dataStoreRepository.js';
import { managerFirstPromptOf } from './managerFirstPrompt.js';
import { isPulseEnabled, type ManagerRecord, type ManagerRepository } from './managerRepository.js';
import { DEFAULT_HEARTBEAT_SECONDS } from '../workingState/workingStateSettings.js';
import { toManagerView, type DeniedCommandCounts, type ManagerBaseIdentity } from './managerView.js';
import { isNoteReadInFull, noteReadEventOf, progressAfterMentionRead, progressAfterRead } from './noteReadGuard.js';

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
  /** The manager base this daemon ships. Absent, the views report no base and a read cannot be recorded. */
  currentBase?: ManagerBaseIdentity;
  clock?: () => string;
}

export class ManagerService {
  private readonly deps: ManagerServiceDeps;

  constructor(deps: ManagerServiceDeps) {
    this.deps = deps;
  }

  async createManagerSession(spec: SessionSpec & { manager: ManagerSpec; repoPath?: string; branchName?: string }): Promise<Session> {
    this.requireMissionWritable({ mission: spec.manager.mission });
    const managerSpec = { ...spec, role: MANAGER_ROLE, seededPrompt: spec.seededPrompt ?? managerFirstPromptOf(spec.manager.mission) };
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
   * Changes the given profile fields atomically; undefined when the session has no manager row.
   * Throws NoteNotFoundError, before changing anything, for a mission note outside the manager's project.
   */
  update(sessionId: string, patch: UpdateManager): ManagerView | undefined {
    const validated = UpdateManagerSchema.parse(patch);
    const { expectedProfileRev } = validated;
    let isPulseEnabledChanged = false;
    const updated = this.deps.managers.changeProfile({
      sessionId, expectedProfileRev,
      apply: (stored) => {
        isPulseEnabledChanged = validated.pulseEnabled !== undefined && validated.pulseEnabled !== isPulseEnabled(stored);
        return this.applyProfilePatch(stored, validated);
      },
      committed: (record) => {
        this.announceUpdated(record);
        const changesExistingFields = Object.entries(validated).some(([key, value]) =>
          value !== undefined && !['expertise', 'pulseActions', 'expectedProfileRev'].includes(key));
        if (changesExistingFields) this.deps.scheduler.onManagerUpdated(record);
        if (isPulseEnabledChanged) this.deps.scheduler.onPulseEnabledChanged(record);
      },
    });
    return updated ? this.view(updated) : undefined;
  }

  private applyProfilePatch(stored: ManagerRecord, patch: UpdateManager): boolean {
    const sessionId = stored.sessionId;
    const { mission, model, missionNoteId, pinMissionNote, pulseEnabled, expertise, pulseActions } = patch;
    if (mission !== undefined) this.requireMissionWritable({ mission, storedMission: stored.missionText });
    const isLinkingNote = typeof missionNoteId === 'string';
    if (isLinkingNote) this.requireNoteOfManagerProject({ managerId: sessionId, noteId: missionNoteId });
    const currentFields = {
      pulseSeconds: stored.pulseSeconds, childrenCap: stored.childrenCap, mission: stored.missionText,
      model: this.deps.sessions.get(sessionId)?.model, missionNoteId: stored.missionNoteId ?? null,
      pinMissionNote: stored.pinMissionNote === true, pulseEnabled: isPulseEnabled(stored),
      expertise: stored.expertise ?? '', pulseActions: stored.pulseActions ?? [],
    };
    const hasChanges = Object.entries(currentFields).some(([key, value]) => {
      const requested = patch[key as keyof typeof currentFields];
      return requested !== undefined && JSON.stringify(requested) !== JSON.stringify(value);
    });
    if (!hasChanges) return false;
    if (model !== undefined && model !== currentFields.model) this.deps.sessions.changeModel(sessionId, model);
    this.deps.managers.update(sessionId, { pulseSeconds: patch.pulseSeconds, childrenCap: patch.childrenCap, missionText: mission, expertise, pulseActions });
    if (missionNoteId !== undefined) this.deps.managers.setMissionNote(sessionId, missionNoteId);
    if (pinMissionNote !== undefined) this.deps.managers.setMissionNotePinned(sessionId, pinMissionNote);
    if (pulseEnabled !== undefined) this.deps.managers.setPulseEnabled(sessionId, pulseEnabled);
    return true;
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

  /** Remembers that the manager read the whole current base, and announces it; undefined when the session has no manager row or no base is shipped. */
  recordBaseRead(sessionId: string): ManagerView | undefined {
    const { currentBase, clock = () => new Date().toISOString() } = this.deps;
    const hasManagerRow = this.deps.managers.get(sessionId) !== undefined;
    if (!currentBase || !hasManagerRow) return undefined;
    this.deps.managers.recordBaseRead(sessionId, { version: currentBase.version, sha: currentBase.sha, readAt: clock() });
    return this.announceUpdated(this.deps.managers.get(sessionId)!);
  }

  /** Forgets that the manager read the base, because its context was reset, and announces it; undefined when the session has no manager row or had read nothing. */
  forgetBaseRead(sessionId: string): ManagerView | undefined {
    const record = this.deps.managers.get(sessionId);
    const hadRead = record?.baseRead !== undefined;
    if (!hadRead) return undefined;
    this.deps.managers.clearBaseRead(sessionId);
    return this.announceUpdated(this.deps.managers.get(sessionId)!);
  }

  /**
   * Counts a get_note response toward the manager reading its mission note in full: the response of the mission note itself,
   * or the whole response of one of the mentions the mission note still owes. Any other note changes nothing.
   */
  recordNoteRead({ sessionId, noteId, noteRev, response }: { sessionId: string; noteId: string; noteRev: number; response: Record<string, unknown> }): void {
    const record = this.deps.managers.get(sessionId);
    const event = noteReadEventOf(response);
    if (!record || !event) return;

    const isMissionNoteRead = noteId === record.missionNoteId;
    const previous = record.noteRead;
    const isOwedMentionRead = previous !== undefined && event.isWhole && previous.mentionIdsToRead.includes(noteId);
    const progress = isMissionNoteRead
      ? progressAfterRead({ previous, noteId, rev: noteRev, event })
      : isOwedMentionRead ? progressAfterMentionRead({ previous, mentionId: noteId }) : undefined;
    if (!progress) return;

    this.deps.managers.setNoteRead(sessionId, progress);
    if (isNoteReadInFull(progress, { noteId: progress.noteId, rev: progress.rev })) this.deps.managers.clearNoteReadReset(sessionId);
  }

  /** Forgets what the manager read of its mission note, because its context was reset; nothing changes for a manager without a mission note. */
  forgetNoteRead(sessionId: string): void {
    const { clock = () => new Date().toISOString() } = this.deps;
    const hasMissionNote = this.deps.managers.get(sessionId)?.missionNoteId !== undefined;
    if (hasMissionNote) this.deps.managers.resetNoteRead(sessionId, clock());
  }

  /** The manager as the profile page shows it: its view, and where it stands against a Scape re-import. */
  profile(sessionId: string): ManagerProfile | undefined {
    const record = this.deps.managers.get(sessionId);
    if (!record) return undefined;
    const scapeImport = this.deps.scapeImportStatusOf?.(sessionId) ?? 'not_imported';
    return { manager: this.view(record), scapeImport };
  }

  /** Whether any manager links the note as its mission. */
  isMissionNote(noteId: string): boolean {
    return this.deps.managers.isMissionNote(noteId);
  }

  listViews(): ManagerView[] {
    return this.deps.managers.list().map((record) => this.view(record));
  }

  private requireMissionWritable({ mission, storedMission }: { mission: string; storedMission?: string }): void {
    if (isMissionWritable({ mission, storedMission })) return;
    throw new OpenFleetError('mission_too_large', `the mission is above ${MAX_MISSION_DELTA_BYTES} bytes: keep the project delta, the manager base holds the rest`);
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
    return toManagerView(record, childrenCount, this.deps.deniedCommandCountsOf?.(record.sessionId), this.deps.currentBase);
  }
}
