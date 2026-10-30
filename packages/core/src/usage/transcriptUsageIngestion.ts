import { readFileSync } from 'node:fs';
import { log } from '../logger.js';
import type { UsageLedgerService } from './usageLedgerService.js';

export interface TranscriptUsageIngestionDeps {
  ledger: Pick<UsageLedgerService, 'ingestTranscript'>;
  /** The path of the session's own transcript when it passed the daemon's trust checks, else undefined. */
  trustedTranscriptFileOf: (sessionId: string) => string | undefined;
  parentOf: (sessionId: string) => string | undefined;
  readTextFile?: (path: string) => string;
}

const readUtf8 = (path: string): string => readFileSync(path, 'utf8');

/**
 * Hands the transcript of a session to the usage ledger when the operator has enabled the ingestion. The ledger keeps
 * the token counts of the assistant lines and nothing else; this class stores, returns and logs no text of the file.
 */
export class TranscriptUsageIngestion {
  constructor(private readonly deps: TranscriptUsageIngestionDeps) {}

  /** Never throws: a failure is logged with a fixed message and changes nothing. */
  ingestAtStop(sessionId: string): void {
    try {
      const transcriptFile = this.deps.trustedTranscriptFileOf(sessionId);
      if (transcriptFile === undefined) return;
      const transcriptText = (this.deps.readTextFile ?? readUtf8)(transcriptFile);
      this.deps.ledger.ingestTranscript({ sessionId, biller: 'subscription', transcriptText, billingCodeOf: (id) => this.rootOf(id) });
    } catch {
      log('warn', 'usage ingestion: the transcript could not be ingested, recording nothing', undefined, { code: 'usage_ingest_failed', sessionId });
    }
  }

  private rootOf(sessionId: string): string {
    const visited = new Set<string>();
    let current = sessionId;
    while (!visited.has(current)) {
      visited.add(current);
      const parent = this.deps.parentOf(current);
      if (parent === undefined) return current;
      current = parent;
    }
    return current;
  }
}
