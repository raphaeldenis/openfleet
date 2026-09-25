import { MANAGER_ROLE, type ManagerSpec, type ManagerView, type Session, type SessionSpec } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { ManagerRecord, ManagerRepository } from './managerRepository.js';
import { toManagerView } from './managerView.js';

export interface PulseSchedulerLike {
  onManagerCreated(record: ManagerRecord): void;
}

export interface ManagerServiceDeps {
  managers: ManagerRepository;
  sessions: SessionService;
  bus: EventBus;
  scheduler: PulseSchedulerLike;
}

export class ManagerService {
  private readonly deps: ManagerServiceDeps;

  constructor(deps: ManagerServiceDeps) {
    this.deps = deps;
  }

  async createManagerSession(spec: SessionSpec & { manager: ManagerSpec }): Promise<Session> {
    const session = await this.deps.sessions.create({
      ...spec,
      role: MANAGER_ROLE,
      seededPrompt: spec.seededPrompt ?? spec.manager.mission,
    });
    const record: ManagerRecord = {
      sessionId: session.id,
      pulseSeconds: spec.manager.pulseSeconds,
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

  listViews(): ManagerView[] {
    return this.deps.managers.list().map((record) => this.view(record));
  }

  private view(record: ManagerRecord): ManagerView {
    const childrenCount = this.deps.sessions.list().filter((s) => s.parentId === record.sessionId && s.state !== 'closed').length;
    return toManagerView(record, childrenCount);
  }
}
