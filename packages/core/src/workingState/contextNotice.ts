import type { ManagerRepository } from '../managers/managerRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { ContextNoticeSettings } from './workingStateSettings.js';

export interface ContextNoticeDeps { sessions: SessionService; managers: ManagerRepository; settings: ContextNoticeSettings }

export class ContextNotice {
  constructor(private readonly deps: ContextNoticeDeps) {}

  measureAtStop(_sessionId: string): void {}

  clearForNewConversation(_sessionId: string): void {}
}
