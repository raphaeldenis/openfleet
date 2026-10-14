import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CommandPolicyFileReadOnlyError } from './commandPolicyErrors.js';
import type { PolicyFile } from './commandPolicyService.js';

const NEW_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;
const OWNER_WRITE_BIT = 0o200;
const UNWRITABLE_ERRNOS = new Set(['EACCES', 'EPERM', 'EROFS']);

const isUnwritable = (error: unknown): boolean => UNWRITABLE_ERRNOS.has((error as NodeJS.ErrnoException).code ?? '');

/** Creates the file exclusively (a planted symlink at that path makes it fail), then flushes it to disk. */
function writeNewFileDurably({ path, contents, mode }: { path: string; contents: string; mode: number }): void {
  const descriptor = openSync(path, 'wx', NEW_FILE_MODE);
  try {
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function flushDirectory(directoryPath: string): void {
  const descriptor = openSync(directoryPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The command policy as a file: it reads nothing when the file is absent, and swaps the new contents in by renaming a
 * temporary file once its bytes are on disk, so a reader or a crash sees the old file or the new one, never half of one.
 * A symlinked file is written through to its target, the file keeps its permissions (a new one gets 0600), and a
 * read-only file or folder is refused.
 */
export function createFileCommandPolicyFile(path: string): PolicyFile {
  return {
    read() {
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    },
    keepCopy() {
      const targetPath = realpathSync(path);
      const copyName = `${basename(path)}.bak-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
      const copyPath = join(dirname(targetPath), copyName);
      try {
        writeNewFileDurably({ path: copyPath, contents: readFileSync(targetPath, 'utf8'), mode: NEW_FILE_MODE });
      } catch (error) {
        if (isUnwritable(error)) throw new CommandPolicyFileReadOnlyError('the command policy file cannot be copied');
        throw error;
      }
      return copyName;
    },
    write(contents) {
      const fileExists = existsSync(path);
      const targetPath = fileExists ? realpathSync(path) : path;
      const mode = fileExists ? statSync(targetPath).mode & PERMISSION_BITS : NEW_FILE_MODE;
      const isReadOnly = (mode & OWNER_WRITE_BIT) === 0;
      if (isReadOnly) throw new CommandPolicyFileReadOnlyError('the command policy file is read-only');

      const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
      try {
        writeNewFileDurably({ path: temporaryPath, contents, mode });
        renameSync(temporaryPath, targetPath);
        flushDirectory(dirname(targetPath));
      } catch (error) {
        rmSync(temporaryPath, { force: true });
        if (isUnwritable(error)) throw new CommandPolicyFileReadOnlyError('the command policy file cannot be written');
        throw error;
      }
    },
  };
}
