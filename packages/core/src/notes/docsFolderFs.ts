/**
 * Thin, synchronous filesystem port `DocsFolderService` writes through — a real `node:fs` adapter
 * (`nodeDocsFolderFs.ts`) and a test double both implement it. Every write primitive is durable once
 * it returns: `writeFileExclusiveSync` refuses an existing path and fsyncs before returning, `renameSync`
 * is the atomic swap and flushes the destination directory too.
 */
export interface DocsFolderFs {
  readFileSync(path: string): string;
  writeFileExclusiveSync(path: string, contents: string): void;
  renameSync(fromPath: string, toPath: string): void;
  unlinkSync(path: string): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string): void;
  realpathSync(path: string): string;
  /** True when the path (symlinks followed) is a directory; false for a file or a missing path; never throws. */
  isDirectorySync(path: string): boolean;
  /** True when the current process can create files in the directory; never throws. */
  isWritableSync(dirPath: string): boolean;
  /** Filenames directly under `dirPath` — not recursive, empty for a directory that does not exist. */
  listFilesSync(dirPath: string): string[];
  /** Watches `dirPath` recursively; returns an unsubscribe that stops all future events. */
  watch(dirPath: string, onEvent: (eventType: 'rename' | 'change', relativePath: string | null) => void): () => void;
}
