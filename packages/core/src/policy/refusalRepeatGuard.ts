import type { RepeatEscalation } from './commandPolicySettings.js';

/** Notices when a session keeps bumping into the same rule, and says so once per window instead of once per refusal. */
export class RefusalRepeatGuard {
  private readonly refusalTimes = new Map<string, number[]>();
  private readonly lastEscalationAt = new Map<string, number>();

  constructor(private readonly deps: { clock: () => number; settings: () => RepeatEscalation }) {}

  /** Registers one refusal and returns true when it is the one the manager must hear about. */
  registerAndShouldEscalate({ sessionId, ruleId }: { sessionId: string; ruleId: string }): boolean {
    const { count, windowSeconds } = this.deps.settings();
    const windowMs = windowSeconds * 1000;
    const now = this.deps.clock();
    const key = JSON.stringify([sessionId, ruleId]);
    const recent = [...(this.refusalTimes.get(key) ?? []).filter((time) => now - time < windowMs), now];
    this.refusalTimes.set(key, recent);
    const lastEscalation = this.lastEscalationAt.get(key);
    const alreadyToldThisWindow = lastEscalation !== undefined && now - lastEscalation < windowMs;
    const hasRepeatedEnough = recent.length >= count;
    if (!hasRepeatedEnough || alreadyToldThisWindow) return false;
    this.lastEscalationAt.set(key, now);
    return true;
  }
}
