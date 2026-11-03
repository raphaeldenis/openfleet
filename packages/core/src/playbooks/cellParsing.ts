import { OpenFleetError, PLAYBOOK_CELL_KINDS, PlaybookCellSchema, RESERVED_PLAYBOOK_CELL_KINDS, type PlaybookCell } from '@openfleet/shared';

const KIND_AS_WRITTEN = /^[A-Za-z]{1,40}$/;

const isOneOf = (kinds: readonly string[], kind: unknown): kind is string => typeof kind === 'string' && kinds.includes(kind);

const nameOf = (kind: unknown): string => (typeof kind === 'string' && KIND_AS_WRITTEN.test(kind) ? kind : 'this');

/** Parses a cell as a caller wrote it; a reserved or unsupported kind is refused with its own stable code before the schema runs. */
export function parsePlaybookCell(raw: Record<string, unknown>): PlaybookCell {
  const { kind } = raw;
  if (isOneOf(RESERVED_PLAYBOOK_CELL_KINDS, kind)) {
    throw new OpenFleetError('cell_kind_reserved', `${kind} cells are reserved for a later wave and cannot be saved yet.`);
  }
  if (kind === 'bash') {
    throw new OpenFleetError('cell_kind_unsupported', 'there is no shell cell: write a script cell with program and args.');
  }
  if (!isOneOf(PLAYBOOK_CELL_KINDS, kind)) {
    throw new OpenFleetError('cell_kind_unsupported', `${nameOf(kind)} is not a cell kind; it is one of ${PLAYBOOK_CELL_KINDS.join(', ')}.`);
  }
  return PlaybookCellSchema.parse(raw);
}
