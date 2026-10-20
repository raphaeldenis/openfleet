import { createHash } from 'node:crypto';
import { OpenFleetError } from '@openfleet/shared';
import { storedLawText } from '../../governance/proposalInput.js';
import type { ScapeArgus, ScapeGovernanceRequest } from './scapeArguses.js';
import { appleReferenceToIso } from './scapeTime.js';

/** Author recorded on the laws the import writes; a law whose last author is another one was edited in OpenFleet. */
export const LAW_IMPORT_MARK = 'scape-import';

const LAW_KIND = 'law';
const APPROVED = 'approved';
const DENIED = 'denied';
const PENDING = 'pending';

export interface PlannedLaw {
  key: string;
  argusId: string;
  /** The text as Scape holds it: the ledger hash is taken from it. */
  sourceText: string;
  /** The text as OpenFleet stores it: visible, secrets masked, bounded. */
  text: string;
  createdAt: string;
  sourceCreatedAt: string;
}

export interface LawsPerManagerReport { argus: string; approved: number; inserted: number; updated: number; conflict: number; alreadyPresent: number }

/** Counts only: never a law text. */
export interface LawsReport {
  approvedInSource: number;
  skippedNotApproved: { denied: number; pending: number };
  invalidText: number;
  exactDuplicates: number;
  keyedBy: { requestId: number; fingerprint: number };
  perManager: LawsPerManagerReport[];
}

export const emptyLawsReport = (): LawsReport => ({
  approvedInSource: 0, skippedNotApproved: { denied: 0, pending: 0 }, invalidText: 0, exactDuplicates: 0, keyedBy: { requestId: 0, fingerprint: 0 }, perManager: [],
});

export interface LawsPlan { laws: PlannedLaw[]; report: LawsReport }

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const normalizedTextOf = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();

const hasRequestId = (request: ScapeGovernanceRequest): request is ScapeGovernanceRequest & { id: string } => (request.id ?? '').trim() !== '';

function storedTextOrUndefined(sourceText: string): string | undefined {
  try {
    return storedLawText(sourceText);
  } catch (error) {
    const isRefusedText = error instanceof OpenFleetError && error.code === 'invalid_body';
    if (isRefusedText) return undefined;
    throw error;
  }
}

/** The key of a law, unique per manager and stable across runs; an exact repeat of a key gets `#n`. */
function uniqueKeyOf(input: { baseKey: string; seenKeys: Map<string, number> }): string {
  const occurrence = (input.seenKeys.get(input.baseKey) ?? 0) + 1;
  input.seenKeys.set(input.baseKey, occurrence);
  return occurrence === 1 ? input.baseKey : `${input.baseKey}#${occurrence}`;
}

function planLawsOfArgus(argus: ScapeArgus, report: LawsReport): PlannedLaw[] {
  const lawRequests = argus.governanceRequests.filter((request) => request.kind === LAW_KIND);
  report.skippedNotApproved.denied += lawRequests.filter((request) => request.status === DENIED).length;
  report.skippedNotApproved.pending += lawRequests.filter((request) => request.status === PENDING).length;
  const approvedRequests = lawRequests.filter((request) => request.status === APPROVED);
  report.approvedInSource += approvedRequests.length;

  const seenKeys = new Map<string, number>();
  const seenTexts = new Set<string>();
  const planned: PlannedLaw[] = [];
  for (const request of approvedRequests) {
    const text = storedTextOrUndefined(request.text);
    if (text === undefined) { report.invalidText++; continue; }

    const fingerprint = sha256(normalizedTextOf(request.text));
    const isExactDuplicate = seenTexts.has(fingerprint);
    seenTexts.add(fingerprint);
    if (isExactDuplicate) report.exactDuplicates++;

    const baseKey = hasRequestId(request) ? `scape:${argus.id}:${request.id}` : `scape:${argus.id}:fp:${fingerprint}`;
    if (hasRequestId(request)) report.keyedBy.requestId++; else report.keyedBy.fingerprint++;
    const resolvedAt = request.resolvedAt ?? request.createdAt;
    planned.push({
      key: uniqueKeyOf({ baseKey, seenKeys }), argusId: argus.id, sourceText: request.text, text,
      createdAt: appleReferenceToIso(resolvedAt), sourceCreatedAt: appleReferenceToIso(request.createdAt),
    });
  }
  return planned;
}

/** Plans the approved laws of the managers the import plans; denied, pending and unusable ones are counted and left out. */
export function planLaws(input: { arguses: ScapeArgus[]; managers: { id: string }[] }): LawsPlan {
  const report = emptyLawsReport();
  const plannedManagerIds = new Set(input.managers.map((manager) => manager.id));
  const laws = input.arguses.filter((argus) => plannedManagerIds.has(argus.id)).flatMap((argus) => planLawsOfArgus(argus, report));
  return { laws, report };
}
