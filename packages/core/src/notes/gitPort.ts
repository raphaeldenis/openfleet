/** Read-only git access for a session's working directory; implementations throw when git is unavailable. */
export interface GitPort {
  /** Output of `git status --short`. */
  statusShort(directory: string): string;
  /** Output of `git diff --stat`. */
  diffStatOf(directory: string): string;
}
