export interface GitCallOptions {
  /** Upper bound for this call; the port never waits longer than its own default either. */
  timeoutMs?: number;
}

/** Read-only git access for a session's working directory; implementations throw when git is unavailable. */
export interface GitPort {
  /** Output of `git status --short`. */
  statusShort(directory: string, options?: GitCallOptions): string;
  /** Output of `git diff --stat`. */
  diffStatOf(directory: string, options?: GitCallOptions): string;
}
