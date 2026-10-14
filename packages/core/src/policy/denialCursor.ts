export interface DenialPosition {
  createdAt: string;
  rowId: number;
}

const POSITION_PATTERN = /^(.+)\|(\d+)$/;

/** An opaque token for "just after this entry" in the newest-first journal; the row id settles entries recorded at the same instant. */
export function encodeDenialCursor({ createdAt, rowId }: DenialPosition): string {
  return Buffer.from(`${createdAt}|${rowId}`, 'utf8').toString('base64url');
}

export function decodeDenialCursor(cursor: string): DenialPosition | undefined {
  const match = POSITION_PATTERN.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (match === null) return undefined;
  const [, createdAt, rowId] = match;
  return { createdAt: createdAt!, rowId: Number(rowId) };
}
