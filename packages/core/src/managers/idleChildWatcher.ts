import { log } from '../logger.js';
import type { SessionService } from '../sessions/sessionService.js';
import { isPulseEnabled, type ManagerRepository } from './managerRepository.js';
import { toSingleLineName } from './singleLineName.js';

export const CHILD_IDLE_WAKE_AFTER_MS = 5 * 60 * 1000;
export const CHILD_IDLE_SWEEP_INTERVAL_MS = 30 * 1000;
export const MAX_CHILD_MESSAGE_LENGTH = 300;

const MS_PER_MINUTE = 60 * 1000;
const ELLIPSIS = '…';

export interface IdleChildWatcherDeps {
  sessions: Pick<SessionService, 'get' | 'list' | 'sendMessage' | 'childExchangeOf'>;
  managers: Pick<ManagerRepository, 'get'>;
  now?: () => number;
  idleAfterMs?: number;
}

const toCappedOneLineMessage = (message: string): string => {
  const characters = Array.from(message.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim());
  const isTooLong = characters.length > MAX_CHILD_MESSAGE_LENGTH;
  return isTooLong ? `${characters.slice(0, MAX_CHILD_MESSAGE_LENGTH).join('')}${ELLIPSIS}` : characters.join('');
};

const idleWakeLineOf = ({ childName, idleMinutes, lastChildMessage }: { childName: string; idleMinutes: number; lastChildMessage: string }): string =>
  `[pulse] Child "${toSingleLineName(childName)}" has been idle for ${idleMinutes} minutes and nothing was exchanged since its last message: "${toCappedOneLineMessage(lastChildMessage)}". Check on it.`;

/** Wakes an idle manager about a child that stayed idle past a threshold with no message exchanged since the child's last one. */
export class IdleChildWatcher {
  private readonly notifiedIdleSinceByChild = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: IdleChildWatcherDeps) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.sweep(), CHILD_IDLE_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.notifiedIdleSinceByChild.clear();
  }

  sweep(): void {
    for (const session of this.deps.sessions.list()) {
      try {
        this.wakeManagerOfIdleChild(session.id);
      } catch (error) {
        log('error', `idle child: could not check child ${session.id}`, error);
      }
    }
  }

  private wakeManagerOfIdleChild(childId: string): void {
    const child = this.deps.sessions.get(childId);
    const managerId = child?.parentId;
    if (!child || !managerId) return;
    if (child.state !== 'idle') { this.notifiedIdleSinceByChild.delete(childId); return; }
    const idleAfterMs = this.deps.idleAfterMs ?? CHILD_IDLE_WAKE_AFTER_MS;
    const idleForMs = (this.deps.now ?? Date.now)() - Date.parse(child.stateSince);
    const isIdleLongEnough = idleForMs > idleAfterMs;
    const isAlreadyNotified = this.notifiedIdleSinceByChild.get(childId) === child.stateSince;
    if (!isIdleLongEnough || isAlreadyNotified) return;
    const manager = this.deps.managers.get(managerId);
    const isManagerIdle = this.deps.sessions.get(managerId)?.state === 'idle';
    if (!manager || !isPulseEnabled(manager) || !isManagerIdle) return;
    const { lastChildMessage, hasExchangeSince } = this.deps.sessions.childExchangeOf({ managerId, childId });
    if (lastChildMessage === undefined || hasExchangeSince) return;
    const idleMinutes = Math.floor(idleForMs / MS_PER_MINUTE);
    this.deps.sessions.sendMessage({ sessionId: managerId, body: idleWakeLineOf({ childName: child.name, idleMinutes, lastChildMessage }) });
    this.notifiedIdleSinceByChild.set(childId, child.stateSince);
  }
}
