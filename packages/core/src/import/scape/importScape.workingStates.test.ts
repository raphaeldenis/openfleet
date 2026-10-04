import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkingStateSections } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkingStateService } from '../../workingState/workingStateService.js';
import { renderImportReport } from './importReport.js';
import { importScape } from './importScape.js';
import { anArgus, CAPTAIN_ARGUS_ID, LEAD_ARGUS_ID, writeArguses } from './scapeArguses.testkit.js';
import { buildScapeFixture, OPENFLEET_NOTE_ID, type ScapeFixture } from './scapeFixture.testkit.js';

const STATE_FILE_MODIFIED_AT = new Date('2026-10-03T08:30:00.000Z');
const SYNTHETIC_STATE_FILE = [
  '# Alpha state', '',
  '## Plan', '- ship the synthetic thing', '',
  '## Todo', '- write the synthetic test', '',
  '## Blocages', '- (none)', '',
  '## Ordres permanents', '- never spawn in a manager folder',
].join('\n');

describe('importScape: working states of the managers', () => {
  let fixture: ScapeFixture;
  let home: string;
  let stateDir: string;
  const openConnections: DatabaseSync[] = [];

  const closeOpenConnections = () => openConnections.splice(0).forEach((db) => db.close());
  afterEach(closeOpenConnections);

  const openTarget = () => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    openConnections.push(db);
    return db;
  };
  const run = (overrides: Partial<Parameters<typeof importScape>[0]> = {}) => {
    closeOpenConnections();
    return importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), managersRoot: join(fixture.workDir, 'managers'), stateDir, ...overrides });
  };
  const writeStateFile = (fileName: string, text = SYNTHETIC_STATE_FILE) => {
    const path = join(stateDir, fileName);
    writeFileSync(path, text);
    utimesSync(path, STATE_FILE_MODIFIED_AT, STATE_FILE_MODIFIED_AT);
    return path;
  };
  const storedState = (managerId: string) => openTarget().prepare('SELECT sections_json, updated_at FROM session_working_states WHERE session_id = ?').get(managerId) as { sections_json: string; updated_at: string } | undefined;
  const stateCount = () => (openTarget().prepare('SELECT count(*) AS n FROM session_working_states').get() as { n: number }).n;
  const stateRead = (managerId: string) => new WorkingStateService({ db: openTarget(), clock: () => STATE_FILE_MODIFIED_AT.toISOString(), stateRoot: join(fixture.workDir, 'mirror'), maxBytes: 6144 }).get(managerId);

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    stateDir = join(fixture.workDir, 'state');
    mkdirSync(stateDir);
    writeArguses(fixture, [anArgus({ name: 'Alpha' })]);
  });

  it('seeds the working state of an imported manager from the file named after it, under the manager session id', () => {
    writeStateFile('alpha.md');

    const report = run();

    expect(stateRead(LEAD_ARGUS_ID)).toMatchObject({
      sessionId: LEAD_ARGUS_ID,
      plan: ['ship the synthetic thing', '[Ordres permanents]', 'never spawn in a manager folder'],
      todo: ['write the synthetic test'],
      blockers: ['(none)'],
      updatedAt: STATE_FILE_MODIFIED_AT.toISOString(),
    });
    expect(report.counts.workingStates).toMatchObject({ expected: 1, written: 1, conflict: 0 });
    expect(report.mergedStateSections).toBe(1);
  });

  it('finds the file of a manager whose name has spaces and punctuation: "Lead (CCM)" reads lead-ccm.md', () => {
    writeArguses(fixture, [anArgus({ name: 'Lead (CCM)' })]);
    writeStateFile('lead-ccm.md');

    run();

    expect(storedState(LEAD_ARGUS_ID)).toBeDefined();
  });

  it('reads lead-ccm.md for a manager named "Lead" when it is the only file starting with "lead-"', () => {
    writeArguses(fixture, [anArgus({ name: 'Lead' })]);
    writeStateFile('lead-ccm.md');

    run();

    expect(storedState(LEAD_ARGUS_ID)).toBeDefined();
  });

  it('prefers the file named exactly after the manager over a longer name', () => {
    writeArguses(fixture, [anArgus({ name: 'Lead' })]);
    writeStateFile('lead-ccm.md', '## Plan\n- the longer name');
    writeStateFile('lead.md', '## Plan\n- the exact name');

    run();

    expect(JSON.parse(storedState(LEAD_ARGUS_ID)!.sections_json).plan).toEqual(['the exact name']);
  });

  it('seeds nothing when two files start with the manager name, rather than guess', () => {
    writeArguses(fixture, [anArgus({ name: 'Lead' })]);
    writeStateFile('lead-ccm.md');
    writeStateFile('lead-oss.md');

    run();

    expect(stateCount()).toBe(0);
  });

  it('seeds nothing for a manager that has no state file, and expects nothing of it', () => {
    const report = run();

    expect(stateCount()).toBe(0);
    expect(report.counts.workingStates.expected).toBe(0);
  });

  it('seeds nothing when no state folder is given', () => {
    writeStateFile('alpha.md');

    run({ stateDir: undefined });

    expect(stateCount()).toBe(0);
  });

  it('seeds nothing when the state folder does not exist', () => {
    run({ stateDir: join(fixture.workDir, 'no-such-folder') });

    expect(stateCount()).toBe(0);
  });

  it('writes only the state of the manager whose file exists, leaving the other manager without state', () => {
    writeArguses(fixture, [anArgus({ name: 'Alpha' }), anArgus({ id: CAPTAIN_ARGUS_ID, name: 'Beta', noteId: OPENFLEET_NOTE_ID })]);
    writeStateFile('beta.md');

    run();

    expect(storedState(CAPTAIN_ARGUS_ID)).toBeDefined();
    expect(storedState(LEAD_ARGUS_ID)).toBeUndefined();
  });

  it('is idempotent: a second run writes nothing and reports the state as already present', () => {
    writeStateFile('alpha.md');
    run();
    const stateAfterFirstRun = storedState(LEAD_ARGUS_ID);

    const secondReport = run({ refuseReimport: false });

    expect(secondReport.counts.workingStates).toMatchObject({ expected: 1, written: 0, updated: 0, alreadyPresent: 1, conflict: 0 });
    expect(storedState(LEAD_ARGUS_ID)).toEqual(stateAfterFirstRun);
  });

  it('leaves a state edited in OpenFleet as it is and reports a conflict', () => {
    writeStateFile('alpha.md');
    run();
    const editedSections: WorkingStateSections = { plan: ['edited in OpenFleet'], todo: [], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [] };
    openTarget().prepare('UPDATE session_working_states SET sections_json = ? WHERE session_id = ?').run(JSON.stringify(editedSections), LEAD_ARGUS_ID);

    const secondReport = run({ refuseReimport: false });

    expect(secondReport.counts.workingStates).toMatchObject({ written: 0, alreadyPresent: 0, conflict: 1 });
    expect(JSON.parse(storedState(LEAD_ARGUS_ID)!.sections_json)).toEqual(editedSections);
  });

  it('writes nothing on a dry run, and still reports what a real run would write', () => {
    writeStateFile('alpha.md');

    const report = run({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.counts.workingStates).toMatchObject({ expected: 1, written: 1 });
    expect(existsSync(join(home, 'openfleet.db'))).toBe(false);
  });

  it('counts a file that had to be cut as not converted', () => {
    writeStateFile('alpha.md', ['## Plan', `- ${'x'.repeat(400)}`].join('\n'));

    const report = run();

    expect(report.counts.workingStates.notConverted).toBe(1);
  });

  it('never reads a state file that is a link to a file elsewhere', () => {
    const outsideFile = join(fixture.workDir, 'outside.md');
    writeFileSync(outsideFile, '## Plan\n- secret outside item');
    symlinkSync(outsideFile, join(stateDir, 'alpha.md'));

    run();

    expect(stateCount()).toBe(0);
  });

  it('never leaves the state folder, whatever the manager is called', () => {
    writeFileSync(join(fixture.workDir, 'evil.md'), '## Plan\n- secret outside item');
    writeArguses(fixture, [anArgus({ name: '../evil' })]);

    run();

    expect(stateCount()).toBe(0);
  });

  it('puts the merged sections and the working states in the report', () => {
    writeStateFile('alpha.md');

    const rendered = renderImportReport(run());

    expect(rendered).toContain('| workingStates | 1 | 1 |');
    expect(rendered).toContain('1 section(s) of the state files were merged');
  });
});
