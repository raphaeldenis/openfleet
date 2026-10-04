export const SCAPE_IMPORT_ERROR_CODES = [
  'INVALID_ARGUMENTS',
  'SCAPE_SOURCE_MISSING',
  'SCAPE_SOURCE_UNREADABLE',
  'UNKNOWN_PROJECT',
  'IMPORT_WRITE_FAILED',
  'DAEMON_RUNNING',
  'ALREADY_IMPORTED',
] as const;

export type ScapeImportErrorCode = (typeof SCAPE_IMPORT_ERROR_CODES)[number];

export class ScapeImportError extends Error {
  readonly code: ScapeImportErrorCode;

  constructor(input: { code: ScapeImportErrorCode; message: string; cause?: unknown }) {
    super(input.message, { cause: input.cause });
    this.code = input.code;
  }
}
