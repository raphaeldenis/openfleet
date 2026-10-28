import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLawsProseCleanup, planLawsProseCleanup, type LawsProseCleanupReport } from './scape/lawsProseCleanup.js';
import { ScapeImportError } from './scape/scapeImportError.js';
import { openDryRunTarget, openWritableTarget } from './scape/scapeTarget.js';

const DATABASE_FILE_NAME = 'openfleet.db';

export interface CleanLawsRequest {
  home: string;
  applies: boolean;
  confirm: string | undefined;
  asJson: boolean;
}

function assertHomeHoldsADatabase(home: string): void {
  if (existsSync(join(home, DATABASE_FILE_NAME))) return;
  throw new ScapeImportError({ code: 'INVALID_ARGUMENTS', message: `no ${DATABASE_FILE_NAME} in ${home}: there is nothing to clean` });
}

/** Plans on a throw-away snapshot of the database, so the home is not touched. */
function planOnSnapshot(home: string) {
  const target = openDryRunTarget({ home, scratchRoot: tmpdir() });
  try {
    return planLawsProseCleanup(target.db);
  } finally {
    target.dispose();
  }
}

function applyToDatabase(request: CleanLawsRequest): LawsProseCleanupReport {
  const target = openWritableTarget(request.home);
  try {
    return applyLawsProseCleanup({ db: target.db, home: request.home, confirm: request.confirm });
  } finally {
    target.dispose();
  }
}

function renderReport(report: LawsProseCleanupReport): string[] {
  const { unrecognizedStandingLaws, lawsSectionsInNotes, guardrailsSectionsInNotes } = report.copiesToReviewByHand;
  return [
    `managers to clean: ${report.managersToClean}`,
    `removable copies: ${report.removableCopies}`,
    `bytes saved: ${report.bytesSaved}`,
    `conflicts (mission edited in OpenFleet, kept): ${report.conflicts}`,
    `copies to review by hand, never touched: ${unrecognizedStandingLaws} unrecognized standing laws, ${lawsSectionsInNotes} Laws sections in notes, ${guardrailsSectionsInNotes} Guardrails sections in notes`,
  ];
}

function renderPlan(input: { report: LawsProseCleanupReport; fingerprint: string; home: string }): string {
  const applyCommand = `import scape clean-laws --home ${input.home} --apply --confirm ${input.fingerprint}`;
  return [
    'Laws prose cleanup plan (nothing is written):',
    ...renderReport(input.report),
    `Fingerprint: ${input.fingerprint}`,
    `To apply this plan: ${applyCommand}`,
    '',
  ].join('\n');
}

const renderApplied = (report: LawsProseCleanupReport) => ['Laws prose cleanup applied:', ...renderReport(report), ''].join('\n');

/** Plans the laws prose cleanup, or applies it with the fingerprint of the plan; the output holds counts only. */
export function runCleanLaws(request: CleanLawsRequest): string {
  assertHomeHoldsADatabase(request.home);
  if (request.applies) {
    const report = applyToDatabase(request);
    return request.asJson ? `${JSON.stringify({ mode: 'apply', report }, null, 2)}\n` : renderApplied(report);
  }
  const { report, fingerprint } = planOnSnapshot(request.home);
  return request.asJson ? `${JSON.stringify({ mode: 'plan', report, fingerprint }, null, 2)}\n` : renderPlan({ report, fingerprint, home: request.home });
}
