import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderImportReport } from './importReport.js';
import { importScape } from './importScape.js';
import { aGrant, anApprovedLaw, anArgus, LEAD_ARGUS_ID, writeArguses } from './scapeArguses.testkit.js';
import { buildScapeFixture, editScapeNotes, LEXICAL_NOTE_ID, MARKDOWN_NOTE_ID, type ScapeFixture } from './scapeFixture.testkit.js';
import { hashOfValues } from './scapeLedger.js';

const MISSION_IN_SCAPE = [
  '# Alpha mission',
  '',
  'Log work with mcp__scape__insert_data_store_rows and change a backlog row with `mcp__scape__update_data_store_row`.',
  'Verify with run_playbook, then read the run with mcp__scape__get_playbook_run.',
  'Plan triggers with mcp__scape__list_triggers.',
  'Report with message_parent.',
].join('\n');

describe('importScape rewrites the Scape tool references of a manager mission', () => {
  let fixture: ScapeFixture;
  let home: string;

  const run = () =>
    importScape({
      scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), managersRoot: join(fixture.workDir, 'managers'),
      scratchRoot: join(fixture.workDir, 'scratch'), stateDir: join(fixture.workDir, 'state'),
    });
  const withTarget = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const missionOfAlpha = () => withTarget((db) => (db.prepare('SELECT mission_text FROM managers WHERE session_id = ?').get(LEAD_ARGUS_ID) as { mission_text: string }).mission_text);
  const setMissionInScape = (content: string) => editScapeNotes(fixture, (db) => db.prepare('UPDATE notes SET content = ? WHERE id = ?').run(content, MARKDOWN_NOTE_ID));
  const makeStoredMissionTheOneAnEarlierImportWrote = (missionText: string) =>
    withTarget((db) => {
      const stored = db.prepare('SELECT pulse_seconds, children_cap FROM managers WHERE session_id = ?').get(LEAD_ARGUS_ID) as { pulse_seconds: number; children_cap: number };
      const model = (db.prepare('SELECT model FROM sessions WHERE id = ?').get(LEAD_ARGUS_ID) as { model: string | null }).model;
      db.prepare('UPDATE managers SET mission_text = ? WHERE session_id = ?').run(missionText, LEAD_ARGUS_ID);
      const hashOfEarlierImport = hashOfValues({ mission_text: missionText, pulse_seconds: stored.pulse_seconds, children_cap: stored.children_cap, model });
      db.prepare("UPDATE scape_import_ledger SET record_hash = ? WHERE kind = 'manager' AND id = ?").run(hashOfEarlierImport, LEAD_ARGUS_ID);
    });

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    mkdirSync(join(fixture.workDir, 'scratch'));
    mkdirSync(join(fixture.workDir, 'state'));
    setMissionInScape(MISSION_IN_SCAPE);
    writeArguses(fixture, [anArgus({
      name: 'Alpha',
      governanceRequests: [anApprovedLaw('never push without a go')],
      resourceGrants: [aGrant({ resourceType: 'note', resourceId: LEXICAL_NOTE_ID, access: 'read' })],
    })]);
  });

  it('gives the OpenFleet prefix to the tools OpenFleet answers, whether bare in the text or in backticks', () => {
    run();

    const mission = missionOfAlpha();

    expect(mission).toContain('mcp__openfleet__insert_data_store_rows');
    expect(mission).toContain('`mcp__openfleet__update_data_store_row`');
    expect(mission).not.toContain('mcp__scape__insert_data_store_rows');
  });

  it('points the playbook tools at the shims documentation', () => {
    run();

    const mission = missionOfAlpha();

    expect(mission).toContain('Verify with a playbook shim script (see docs/playbook-shims.md)');
    expect(mission).toContain('read the run with the exit status and output of the playbook shim script');
    expect(mission).not.toMatch(/run_playbook|get_playbook_run/);
  });

  it('leaves a Scape tool without an OpenFleet equivalent and a bare OpenFleet tool name as they are', () => {
    run();

    const mission = missionOfAlpha();

    expect(mission).toContain('mcp__scape__list_triggers');
    expect(mission).toContain('Report with message_parent.');
  });

  it('keeps the laws and the exposed resources as the mission always carried them', () => {
    run();

    const mission = missionOfAlpha();

    expect(mission).toContain('## Laws\n\n### Standing laws\n- never push without a go');
    expect(mission).toContain(`## Exposed Resources\n- @note:${LEXICAL_NOTE_ID} (read)`);
  });

  it('counts what it renamed, pointed at the shims and could not map in the report', () => {
    const report = run();

    expect(report.missionToolReferences).toEqual({ renamed: 2, pointedAtPlaybookShims: 2, withoutEquivalent: { list_triggers: 1 } });
  });

  it('writes nothing on a second run', () => {
    run();

    const report = run();

    expect(report.counts.managers).toMatchObject({ alreadyPresent: 1, written: 0, updated: 0, conflict: 0 });
  });

  it('updates a manager an earlier import wrote with the Scape names, when OpenFleet left it alone', () => {
    run();
    makeStoredMissionTheOneAnEarlierImportWrote(MISSION_IN_SCAPE);

    const report = run();

    expect(missionOfAlpha()).toContain('mcp__openfleet__insert_data_store_rows');
    expect(report.counts.managers).toMatchObject({ updated: 1, conflict: 0 });
  });

  it('leaves a mission edited in OpenFleet as it is, and reports a conflict', () => {
    run();
    makeStoredMissionTheOneAnEarlierImportWrote(MISSION_IN_SCAPE);
    withTarget((db) => db.prepare('UPDATE managers SET mission_text = ? WHERE session_id = ?').run('my own mission with mcp__scape__get_note', LEAD_ARGUS_ID));

    const report = run();

    expect(missionOfAlpha()).toBe('my own mission with mcp__scape__get_note');
    expect(report.counts.managers).toMatchObject({ conflict: 1, updated: 0 });
  });

  it('lists the tools without an equivalent in the rendered report', () => {
    const report = run();

    expect(renderImportReport(report)).toContain('## Scape tool references in manager missions\n2 reference(s) renamed to the OpenFleet tool, 2 playbook tool reference(s) pointed at docs/playbook-shims.md. Left as they are, no OpenFleet equivalent:\n- list_triggers: 1');
  });
});
