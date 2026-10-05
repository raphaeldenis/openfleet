interface QueryPageInput<T> {
  rows: T[];
  total: number;
  offset: number;
  maxBytes: number;
  header?: { columns: string[]; names: string[] };
}

export function queryPage<T>({ rows, total, offset, maxBytes, header = undefined }: QueryPageInput<T>) {
  const metadata = (count: number) => {
    const hasMore = offset + count < total;
    return { total, next_offset: hasMore && count > 0 ? offset + count : null, truncated: hasMore, count };
  };
  const kept: T[] = [];
  let rowBytes = 0;
  for (const row of rows) {
    const candidateCount = kept.length + 1;
    const separatorBytes = kept.length > 0 ? 1 : 0;
    const candidateRowBytes = rowBytes + separatorBytes + Buffer.byteLength(JSON.stringify(row), 'utf8');
    const envelopeBytes = Buffer.byteLength(JSON.stringify({ ...header, rows: [], ...metadata(candidateCount) }), 'utf8');
    const exceedsBudget = candidateRowBytes + envelopeBytes > maxBytes;
    if (exceedsBudget) return { ...header, rows: kept, ...metadata(kept.length), truncated: true };
    kept.push(row);
    rowBytes = candidateRowBytes;
  }
  return { ...header, rows: kept, ...metadata(kept.length) };
}
