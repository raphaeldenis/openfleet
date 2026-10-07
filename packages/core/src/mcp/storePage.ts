import { OpenFleetError, type DsRow } from '@openfleet/shared';
import { columnView, type RowProjection, rowView } from './toolViews.js';

interface StorePageInput {
  columns: ReturnType<typeof columnView>[];
  rows: DsRow[];
  totalRowCount: number;
  offset: number;
  maxBytes: number;
  projection: RowProjection;
}

export function newestRowsFirst(first: DsRow, second: DsRow): number {
  if (first.updatedAt !== second.updatedAt) return first.updatedAt > second.updatedAt ? -1 : 1;
  if (first.id === second.id) return 0;
  return first.id < second.id ? -1 : 1;
}

export function storePage({ columns, rows, totalRowCount, offset, maxBytes, projection }: StorePageInput) {
  const keptRows: ReturnType<typeof rowView>[] = [];
  const envelope = ({ truncated }: { truncated: boolean }) => {
    const returned = keptRows.length;
    const hasMore = offset + returned < totalRowCount;
    return { columns, rows: keptRows, totalRowCount, returned, offset, next_offset: hasMore ? offset + returned : null, truncated };
  };
  const refuseOversizedPage = () => {
    throw new OpenFleetError('invalid_body', 'The page exceeds the 1 MiB output budget; select fewer columns or ask for a smaller limit.');
  };
  const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify(envelope({ truncated: false })), 'utf8');
  if (emptyEnvelopeBytes > maxBytes) refuseOversizedPage();
  let rowBytes = 0;
  for (const row of rows) {
    const viewedRow = rowView(row, projection);
    const separatorBytes = keptRows.length > 0 ? 1 : 0;
    const candidateRowBytes = rowBytes + separatorBytes + Buffer.byteLength(JSON.stringify(viewedRow), 'utf8');
    keptRows.push(viewedRow);
    const candidateEnvelope = { ...envelope({ truncated: false }), rows: [] };
    const envelopeBytes = Buffer.byteLength(JSON.stringify(candidateEnvelope), 'utf8');
    const exceedsBudget = candidateRowBytes + envelopeBytes > maxBytes;
    if (exceedsBudget) {
      keptRows.pop();
      if (keptRows.length === 0) refuseOversizedPage();
      return envelope({ truncated: true });
    }
    rowBytes = candidateRowBytes;
  }
  return envelope({ truncated: false });
}
