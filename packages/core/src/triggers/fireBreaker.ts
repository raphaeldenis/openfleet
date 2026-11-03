export const MAX_FIRES_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

/** A global cap on the effects the engine starts in a sliding minute, whatever the trigger. */
export class FireBreaker {
  private readonly startedAt: number[] = [];

  constructor(private readonly clock: () => number) {}

  /** True and counted when one more effect fits in the last minute; false when the cap is reached. */
  tryStart(): boolean {
    const now = this.clock();
    while (this.startedAt.length > 0 && now - this.startedAt[0]! >= WINDOW_MS) this.startedAt.shift();
    const isOpen = this.startedAt.length >= MAX_FIRES_PER_MINUTE;
    if (isOpen) return false;
    this.startedAt.push(now);
    return true;
  }
}
