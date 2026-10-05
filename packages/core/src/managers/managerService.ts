import { MANAGER_ROLE, type ManagerProfile, type ManagerSpec, type ManagerView, type ScapeImportStatus, type Session, type SessionSpec, type UpdateManager } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { ManagerRecord, ManagerRepository } from './managerRepository.js';
import { DEFAULT_HEARTBEAT_SECONDS } from '../workingState/workingStateSettings.js';
import { toManagerView } from './managerView.js';

export interface PulseSchedulerLike {
  onManagerCreated(record: ManagerRecord): void;
  onManagerUpdated(record: ManagerRecord): void;
}

export interface ManagerServiceDeps {
  managers: ManagerRepository;
  sessions: SessionService;
  bus: EventBus;
  scheduler: PulseSchedulerLike;
  heartbeatDefaultSeconds?: number;
  /** Absent, no manager counts as imported. */
  scapeImportStatusOf?: (sessionId: string) => ScapeImportStatus;
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

  /** Changes the pulse, cap or mission of a manager; undefined when the session has no manager row. */
  update(sessionId: string, patch: UpdateManager): ManagerView | undefined {
    if (!this.deps.managers.get(sessionId)) return undefined;
    const { mission, model, ...cadenceAndCap } = patch;
    if (model !== undefined) this.deps.sessions.changeModel(sessionId, model);
    this.deps.managers.update(sessionId, { ...cadenceAndCap, missionText: mission });
    const updated = this.deps.managers.get(sessionId)!;
    const view = this.view(updated);
    this.deps.bus.emit({ type: 'manager.updated', manager: view });
    this.deps.scheduler.onManagerUpdated(updated);
    return view;
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

  private view(record: ManagerRecord): ManagerView {
    const childrenCount = this.deps.sessions.list().filter((s) => s.parentId === record.sessionId && s.state !== 'closed').length;
    return toManagerView(record, childrenCount);
  }
}
