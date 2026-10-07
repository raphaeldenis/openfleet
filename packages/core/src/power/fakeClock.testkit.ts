export class FakeClock {
  private timeMs = Date.parse('2026-10-07T12:00:00Z');
  private readonly timers = new Map<() => void, number>();
  now = (): number => this.timeMs;
  schedule = (callback: () => void, delayMs: number): (() => void) => {
    this.timers.set(callback, this.timeMs + delayMs);
    return () => { this.timers.delete(callback); };
  };

  suspendMs(durationMs: number): void { this.timeMs += durationMs; }

  advanceActiveMs(durationMs: number): void {
    const target = this.timeMs + durationMs;
    for (;;) {
      const next = [...this.timers].sort((left, right) => left[1] - right[1])[0];
      if (!next || next[1] > target) break;
      const [callback, dueAt] = next;
      this.timeMs = Math.max(this.timeMs, dueAt);
      this.timers.delete(callback);
      callback();
    }
    this.timeMs = target;
  }
}
