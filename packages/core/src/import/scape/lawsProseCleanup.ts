import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../../db/transaction.js';
import { ManagerRepository } from '../../managers/managerRepository.js';
import { SessionRepository } from '../../sessions/sessionRepository.js';
import { ScapeImportError } from './scapeImportError.js';
import { hashOfValues, ImportLedger } from './scapeLedger.js';
import { storedValuesOf, type Repositories } from './scapeManagersWriter.js';
import { backUpCommittedState, type RecordValues } from './scapeTarget.js';
import { renameScapeToolReferences } from './scapeToolNames.js';

const MANAGER_LEDGER_KIND = 'manager';
const SECTION_SEPARATOR = '\n\n';
const CONTINUATION_INDENT = '  ';
const BULLET_MARK = '- ';

const STANDING_LAWS_SECTION = '## Laws\n\n### Standing laws\n';
const PERMISSIONS_SECTION = '## Laws\n\n### Permissions\n';
const IMPORT_SECTION_MARKERS = [STANDING_LAWS_SECTION, PERMISSIONS_SECTION];
const SECTIONS_THAT_MAY_FOLLOW_THE_BLOCK = [`${SECTION_SEPARATOR}### Permissions\n`, `${SECTION_SEPARATOR}## Exposed Resources\n`];

const LAWS_HEADING = /^#{1,6}[ \t]+Laws[ \t]*$/gim;
const GUARDRAILS_HEADING = /^#{1,6}[ \t]+Guardrails[ \t]*$/gim;

/** Counts only: never a law text. */
export interface LawsProseCleanupReport {
  managersToClean: number;
  removableCopies: number;
  bytesSaved: number;
  conflicts: number;
  copiesToReviewByHand: { unrecognizedStandingLaws: number; lawsSectionsInNotes: number; guardrailsSectionsInNotes: number };
}

export interface LawsProseCleanupPlan {
  report: LawsProseCleanupReport;
  /** The identity of this plan: the application runs only with the fingerprint of the plan it applies. */
  fingerprint: string;
}

type StandingBlockVerdict =
  | { kind: 'absent' }
  | { kind: 'conflict' }
  | { kind: 'unrecognized'; copyCount: number }
  | { kind: 'removable'; copyCount: number; cleanedMissionText: string };

interface ManagerAnalysis {
  managerId: string;
  verdict: StandingBlockVerdict;
  lawsSectionsInNote: number;
  guardrailsSectionsInNote: number;
  storedValues: RecordValues;
}

const countMatches = (text: string, heading: RegExp) => text.match(heading)?.length ?? 0;

const lastSectionStartOf = (text: string, marker: string): number => {
  for (let candidate = text.lastIndexOf(marker); candidate !== -1; candidate = candidate === 0 ? -1 : text.lastIndexOf(marker, candidate - 1)) {
    const startsASection = candidate === 0 || text.slice(candidate - SECTION_SEPARATOR.length, candidate) === SECTION_SEPARATOR;
    if (startsASection) return candidate;
  }
  return -1;
};

/** The start of the last `## Laws` section the import composes (the standing laws one or the permissions one), or -1. */
const importLawsSectionStartOf = (missionText: string): number => Math.max(...IMPORT_SECTION_MARKERS.map((marker) => lastSectionStartOf(missionText, marker)));

/** The bullet the earlier import wrote for a law: its text with the tool references rewritten, continuation lines indented. */
const legacyStandingLawBullet = (lawText: string) => `${BULLET_MARK}${renameScapeToolReferences(lawText).text.replaceAll('\n', `\n${CONTINUATION_INDENT}`)}`;

function bulletsOf(blockLines: string[]): string[] | undefined {
  const bullets: string[] = [];
  for (const line of blockLines) {
    if (line.startsWith(BULLET_MARK)) bullets.push(line);
    else if (line.startsWith(CONTINUATION_INDENT) && bullets.length > 0) bullets[bullets.length - 1] += `\n${line}`;
    else return undefined;
  }
  return bullets.length === 0 ? undefined : bullets;
}

function activeImportedLawBullets(db: DatabaseSync, managerId: string): Map<string, number> {
  const keyPrefix = `scape:${managerId}:`;
  const rows = db.prepare("SELECT text FROM laws WHERE manager_id = ? AND status = 'active' AND substr(source_key, 1, ?) = ?").all(managerId, keyPrefix.length, keyPrefix) as { text: string }[];
  const copiesAvailable = new Map<string, number>();
  for (const { text } of rows) {
    const bullet = legacyStandingLawBullet(text);
    copiesAvailable.set(bullet, (copiesAvailable.get(bullet) ?? 0) + 1);
  }
  return copiesAvailable;
}

function everyBulletIsAnActiveLaw(bullets: string[], copiesAvailable: Map<string, number>): boolean {
  for (const bullet of bullets) {
    const remaining = copiesAvailable.get(bullet) ?? 0;
    if (remaining === 0) return false;
    copiesAvailable.set(bullet, remaining - 1);
  }
  return true;
}

function standingBlockVerdictOf(input: { db: DatabaseSync; managerId: string; missionText: string; isMissionIntact: boolean }): StandingBlockVerdict {
  const { db, managerId, missionText } = input;
  const sectionStart = importLawsSectionStartOf(missionText);
  const hasStandingBlock = sectionStart !== -1 && missionText.startsWith(STANDING_LAWS_SECTION, sectionStart);
  if (!hasStandingBlock) return { kind: 'absent' };
  if (!input.isMissionIntact) return { kind: 'conflict' };

  const afterSectionHeading = missionText.slice(sectionStart + STANDING_LAWS_SECTION.length);
  const blockEnd = afterSectionHeading.indexOf(SECTION_SEPARATOR);
  const blockText = blockEnd === -1 ? afterSectionHeading : afterSectionHeading.slice(0, blockEnd);
  const textAfterBlock = blockEnd === -1 ? '' : afterSectionHeading.slice(blockEnd);
  const bullets = bulletsOf(blockText.split('\n'));
  const copyCount = Math.max(1, blockText.split('\n').filter((line) => line.startsWith(BULLET_MARK)).length);

  const isFollowedByImportSectionsOnly = textAfterBlock === '' || SECTIONS_THAT_MAY_FOLLOW_THE_BLOCK.some((section) => textAfterBlock.startsWith(section));
  const isExactlyTheBlockOfTheEarlierImport = bullets !== undefined && isFollowedByImportSectionsOnly && everyBulletIsAnActiveLaw(bullets, activeImportedLawBullets(db, managerId));
  if (!isExactlyTheBlockOfTheEarlierImport) return { kind: 'unrecognized', copyCount };

  const keepsPermissions = textAfterBlock.startsWith(SECTIONS_THAT_MAY_FOLLOW_THE_BLOCK[0]!);
  const textBefore = missionText.slice(0, sectionStart);
  const cleanedMissionText = keepsPermissions
    ? `${textBefore}## Laws${textAfterBlock}`
    : cleanedMissionWithoutLawsSection({ textBefore, textAfterBlock });
  return { kind: 'removable', copyCount: bullets.length, cleanedMissionText };
}

function cleanedMissionWithoutLawsSection(input: { textBefore: string; textAfterBlock: string }): string {
  const { textBefore, textAfterBlock } = input;
  const startsWithTheLawsSection = textBefore === '';
  if (startsWithTheLawsSection) return textAfterBlock.slice(SECTION_SEPARATOR.length);
  return textBefore.slice(0, -SECTION_SEPARATOR.length) + textAfterBlock;
}

function analyzeManager(input: { db: DatabaseSync; repositories: Repositories; ledger: ImportLedger; managerId: string }): ManagerAnalysis | undefined {
  const { db, repositories, ledger, managerId } = input;
  const storedValues = storedValuesOf(repositories, managerId);
  if (storedValues === undefined) return undefined;

  const missionText = storedValues.mission_text as string;
  const isMissionIntact = hashOfValues(storedValues) === ledger.hashOf(MANAGER_LEDGER_KIND, managerId);
  const verdict = standingBlockVerdictOf({ db, managerId, missionText, isMissionIntact });
  const sectionStart = importLawsSectionStartOf(missionText);
  const proseOfTheNote = sectionStart === -1 ? missionText : missionText.slice(0, sectionStart);
  return {
    managerId, verdict, storedValues,
    lawsSectionsInNote: countMatches(proseOfTheNote, LAWS_HEADING),
    guardrailsSectionsInNote: countMatches(proseOfTheNote, GUARDRAILS_HEADING),
  };
}

function analyzeImportedManagers(db: DatabaseSync): ManagerAnalysis[] {
  const repositories: Repositories = { sessions: new SessionRepository(db), managers: new ManagerRepository(db) };
  const ledger = new ImportLedger(db);
  const managerIds = ledger.idsOf(MANAGER_LEDGER_KIND).sort();
  return managerIds.flatMap((managerId) => analyzeManager({ db, repositories, ledger, managerId }) ?? []);
}

const byteLengthOf = (text: string) => Buffer.byteLength(text);

const removableOf = (analyses: ManagerAnalysis[]) =>
  analyses.flatMap((analysis) => (analysis.verdict.kind === 'removable' ? [{ analysis, verdict: analysis.verdict }] : []));

function reportOf(analyses: ManagerAnalysis[]): LawsProseCleanupReport {
  const removable = removableOf(analyses);
  const verdicts = analyses.map(({ verdict }) => verdict);
  return {
    managersToClean: removable.length,
    removableCopies: removable.reduce((total, { verdict }) => total + verdict.copyCount, 0),
    bytesSaved: removable.reduce((total, { analysis, verdict }) => total + byteLengthOf(analysis.storedValues.mission_text as string) - byteLengthOf(verdict.cleanedMissionText), 0),
    conflicts: verdicts.filter(({ kind }) => kind === 'conflict').length,
    copiesToReviewByHand: {
      unrecognizedStandingLaws: verdicts.reduce((total, verdict) => total + (verdict.kind === 'unrecognized' ? verdict.copyCount : 0), 0),
      lawsSectionsInNotes: analyses.reduce((total, { lawsSectionsInNote }) => total + lawsSectionsInNote, 0),
      guardrailsSectionsInNotes: analyses.reduce((total, { guardrailsSectionsInNote }) => total + guardrailsSectionsInNote, 0),
    },
  };
}

/** The same report and the same managers always give the same fingerprint. */
function fingerprintOf(input: { report: LawsProseCleanupReport; analyses: ManagerAnalysis[] }): string {
  const managersWithAStandingBlock = input.analyses.filter(({ verdict }) => verdict.kind !== 'absent').map(({ managerId, verdict }) => [managerId, verdict.kind]);
  return createHash('sha256').update(JSON.stringify({ report: input.report, managers: managersWithAStandingBlock })).digest('hex');
}

function planOf(analyses: ManagerAnalysis[]): LawsProseCleanupPlan {
  const report = reportOf(analyses);
  return { report, fingerprint: fingerprintOf({ report, analyses }) };
}

/** Plans the removal of the Standing laws copies that the laws table already holds, without writing anything; the report holds counts only. */
export function planLawsProseCleanup(db: DatabaseSync): LawsProseCleanupPlan {
  return planOf(analyzeImportedManagers(db));
}

function writeCleanedMissions(db: DatabaseSync, analyses: ManagerAnalysis[]): void {
  const ledger = new ImportLedger(db);
  for (const { analysis, verdict } of removableOf(analyses)) {
    const { managerId, storedValues } = analysis;
    db.prepare('UPDATE managers SET mission_text = ?, profile_rev = profile_rev + 1 WHERE session_id = ?').run(verdict.cleanedMissionText, managerId);
    ledger.remember({ kind: MANAGER_LEDGER_KIND, id: managerId, hash: hashOfValues({ ...storedValues, mission_text: verdict.cleanedMissionText }) });
  }
}

const notConfirmed = () => new ScapeImportError({
  code: 'CLEANUP_NOT_CONFIRMED',
  message: 'the laws prose cleanup runs only with the fingerprint of its current plan: preview the plan again and pass the fingerprint it shows',
});

/**
 * Removes the planned copies in one transaction, after a backup of the committed state.
 * Refuses unless `confirm` is the fingerprint of the plan the database holds right now.
 */
export function applyLawsProseCleanup(input: { db: DatabaseSync; home: string; confirm: string | undefined }): LawsProseCleanupReport {
  return inTransaction(input.db, 'lawsProseCleanup', () => {
    const analyses = analyzeImportedManagers(input.db);
    const plan = planOf(analyses);
    const isConfirmed = input.confirm === plan.fingerprint;
    if (!isConfirmed) throw notConfirmed();

    const hasNothingToRemove = plan.report.managersToClean === 0;
    if (hasNothingToRemove) return plan.report;

    backUpCommittedState({ home: input.home });
    writeCleanedMissions(input.db, analyses);
    return plan.report;
  });
}
