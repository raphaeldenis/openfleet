import type { ActivityRow } from '@openfleet/shared';
import { showInvisibleControlsAsEscapes } from '../core/bidi-escapes';

const NO_VALUE = '—';

/** Text the log carries, with every invisible or bidi control spelled out so it reads as what it is. */
export const inertText = showInvisibleControlsAsEscapes;

/** "2026-11-01 14:10:03", the UTC wall-clock time of the row. */
export const utcTimeOf = (row: ActivityRow): string => row.at.slice(0, 19).replace('T', ' ');

/** What the row acted on: its label, else its id, else a dash. */
export const entityNameOf = (row: ActivityRow): string => inertText(row.entityLabel ?? row.entityId ?? NO_VALUE);

export interface DetailField {
  readonly label: string;
  readonly value: string;
}

/** The fields of the row worth a line in its detail, in reading order; a field the row does not carry is left out. */
export function detailFieldsOf(row: ActivityRow): DetailField[] {
  const candidates: Array<[string, string | undefined]> = [
    ['Time (UTC)', row.at],
    ['Source', row.source],
    ['Session', row.sessionId],
    ['Manager', row.managerId],
    ['Entity id', row.entityId],
    ['Duration', row.durationMs === undefined ? undefined : `${row.durationMs} ms`],
    ['Detail', row.detail],
    ['Arguments', row.argsExcerpt],
    ['Result', row.resultExcerpt],
  ];
  return candidates.flatMap(([label, value]) => (value === undefined ? [] : [{ label, value: inertText(value) }]));
}
