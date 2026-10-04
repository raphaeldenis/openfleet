import { copyFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const WAL_SIDE_FILE_SUFFIXES = ['-wal', '-shm'];
const ROLLBACK_JOURNAL_SUFFIX = '-journal';
const sqlStringLiteral = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * Copies a SQLite database to a path of the caller's. A source with WAL side files is in use: a read-only
 * connection takes one consistent snapshot of it (the side files already exist, so nothing is created
 * beside the source). A source without them is a plain file and is copied as is, because even a read-only
 * connection would leave `-wal` and `-shm` files behind it. A rollback journal is copied with the file, so
 * that the first connection on the copy rolls back what the source had not committed. A write that
 * starts while the files are copied can still tear the copy: the caller checks the copy before reading it.
 */
export function snapshotSqliteDatabase(input: { sourcePath: string; targetPath: string }): void {
  const isInUse = WAL_SIDE_FILE_SUFFIXES.some((suffix) => existsSync(`${input.sourcePath}${suffix}`));
  if (!isInUse) {
    copyPlainFile(input);
    return;
  }
  const source = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO ${sqlStringLiteral(input.targetPath)}`);
  } finally {
    source.close();
  }
}

function copyPlainFile(input: { sourcePath: string; targetPath: string }): void {
  const journalPath = `${input.sourcePath}${ROLLBACK_JOURNAL_SUFFIX}`;
  const hasJournal = existsSync(journalPath);
  if (hasJournal) copyFileSync(journalPath, `${input.targetPath}${ROLLBACK_JOURNAL_SUFFIX}`);
  copyFileSync(input.sourcePath, input.targetPath);
}
