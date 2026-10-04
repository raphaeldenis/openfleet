import { copyFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const WAL_SIDE_FILE_SUFFIXES = ['-wal', '-shm'];
const sqlStringLiteral = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * Copies a SQLite database to a path of the caller's. A source with WAL side files is in use: a read-only
 * connection takes one consistent snapshot of it (the side files already exist, so nothing is created
 * beside the source). A source without them is a plain file and is copied as is, because even a read-only
 * connection would leave `-wal` and `-shm` files behind it.
 */
export function snapshotSqliteDatabase(input: { sourcePath: string; targetPath: string }): void {
  const isInUse = WAL_SIDE_FILE_SUFFIXES.some((suffix) => existsSync(`${input.sourcePath}${suffix}`));
  if (!isInUse) {
    copyFileSync(input.sourcePath, input.targetPath);
    return;
  }
  const source = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO ${sqlStringLiteral(input.targetPath)}`);
  } finally {
    source.close();
  }
}
