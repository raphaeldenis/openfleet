const SQLITE_PERM = 3;
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;
const PRIMARY_CODE_MASK = 0xff;

const UNAVAILABLE_PRIMARY_CODES: ReadonlySet<number> = new Set([SQLITE_PERM, SQLITE_READONLY, SQLITE_IOERR, SQLITE_CORRUPT, SQLITE_FULL, SQLITE_CANTOPEN, SQLITE_NOTADB]);

/** True for a sqlite error that says the database cannot take work (permissions, read-only, I/O, corruption, full disk, cannot open, not a database); the error of a caller's bad statement is not one. */
export function isDatabaseUnavailableError(error: unknown): boolean {
  try {
    const errcode = (error as { errcode?: unknown } | null | undefined)?.errcode;
    return typeof errcode === 'number' && UNAVAILABLE_PRIMARY_CODES.has(errcode & PRIMARY_CODE_MASK);
  } catch {
    return false;
  }
}
