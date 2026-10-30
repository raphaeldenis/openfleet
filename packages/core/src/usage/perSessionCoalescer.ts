/**
 * Runs at most one pending task per session: a request made while the session's task waits to run is dropped, since the
 * pending task reads everything that exists when it runs.
 */
export class PerSessionCoalescer {
  private readonly pendingSessions = new Set<string>();

  constructor(private readonly schedule: (task: () => void) => void = setImmediate) {}

  request(sessionId: string, task: () => void): void {
    const isAlreadyPending = this.pendingSessions.has(sessionId);
    if (isAlreadyPending) return;
    this.pendingSessions.add(sessionId);
    this.schedule(() => {
      this.pendingSessions.delete(sessionId);
      task();
    });
  }
}
