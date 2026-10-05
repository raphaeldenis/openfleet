export interface RowWrite {
  outcome: 'inserted' | 'updated';
  rowId: string;
}

export interface RowBatchReport {
  insertedRowIDs: string[];
  updatedRowIDs: string[];
  /** One `row N: reason` line per row that wrote nothing, N counting from 1 in the order sent. */
  failures: string[];
}

/**
 * Writes each item on its own: an item the store rejects is reported and the others still commit.
 * An error that is no rejection of the item (`rejectionReasonOf` answers undefined) is not the item's fault: it stops the batch and propagates.
 */
export function writeRowByRow<Item>(items: Item[], { write, rejectionReasonOf }: { write: (item: Item) => RowWrite; rejectionReasonOf: (error: unknown) => string | undefined }): RowBatchReport {
  const report: RowBatchReport = { insertedRowIDs: [], updatedRowIDs: [], failures: [] };
  items.forEach((item, index) => {
    try {
      const { outcome, rowId } = write(item);
      (outcome === 'inserted' ? report.insertedRowIDs : report.updatedRowIDs).push(rowId);
    } catch (error) {
      const reason = rejectionReasonOf(error);
      if (reason === undefined) throw error;
      report.failures.push(`row ${index + 1}: ${reason}`);
    }
  });
  return report;
}
