/** Lets one request per key through in each window; the window restarts at the last admitted request. */
export class OncePerWindowPerKey {
  private readonly lastAdmittedAt = new Map<string, number>();

  constructor(private readonly windowMs: number, private readonly clock: () => number = Date.now) {}

  admits(key: string): boolean {
    const now = this.clock();
    const lastAdmittedAt = this.lastAdmittedAt.get(key);
    const isInsideTheWindow = lastAdmittedAt !== undefined && now - lastAdmittedAt < this.windowMs;
    if (isInsideTheWindow) return false;
    this.lastAdmittedAt.set(key, now);
    return true;
  }
}
