import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { importScape } from './importScape.js';
import { anApprovedLaw, anApprovedPermission, anArgus, LEAD_ARGUS_ID, writeArguses } from './scapeArguses.testkit.js';
import { buildScapeFixture, type ScapeFixture } from './scapeFixture.testkit.js';
import { hashOfValues } from './scapeLedger.js';

const LAW_TEXT = 'Invented law one.';
const OLD_MISSION_WITH_COPIED_LAW = `# Rules\n\nbe kind\n\n## Laws\n\n### Standing laws\n- ${LAW_TEXT}\n\n### Permissions\n- Invented permission.`;
const MISSION_WITHOUT_LAW = '# Rules\n\nbe kind\n\n## Laws\n\n### Permissions\n- Invented permission.';

describe('importScape re-imports a manager whose mission still holds the laws copied by an earlier import', () => {
  let fixture: ScapeFixture;
  let home: string;

  const run = () => importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), managersRoot: join(fixture.workDir, 'managers') });
  const withTarget = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const storedManager = () => withTarget((db) => db.prepare('SELECT mission_text, profile_rev FROM managers WHERE session_id = ?').get(LEAD_ARGUS_ID) as { mission_text: string; profile_rev: number });
  const storedLaws = () => withTarget((db) => db.prepare('SELECT source_key, text, status, revision FROM laws ORDER BY source_key').all());
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
    writeArguses(fixture, [anArgus({
      governanceRequests: [anApprovedLaw(LAW_TEXT), anApprovedPermission({ text: 'Invented permission.', scope: '', condition: '', exclusions: '' })],
    })]);
    run();
  });

  it('drops the copied law from an intact mission, reports it updated and raises the profile revision once', () => {
    makeStoredMissionTheOneAnEarlierImportWrote(OLD_MISSION_WITH_COPIED_LAW);
    const revisionBefore = storedManager().profile_rev;

    const report = run();

    expect(storedManager()).toEqual({ mission_text: MISSION_WITHOUT_LAW, profile_rev: revisionBefore + 1 });
    expect(report.counts.managers).toMatchObject({ updated: 1, conflict: 0, written: 0 });
  });

  it('writes nothing on the pass after', () => {
    makeStoredMissionTheOneAnEarlierImportWrote(OLD_MISSION_WITH_COPIED_LAW);
    run();
    const managerAfterTheUpdate = storedManager();

    const report = run();

    expect(storedManager()).toEqual(managerAfterTheUpdate);
    expect(report.counts.managers).toMatchObject({ updated: 0, conflict: 0, written: 0, alreadyPresent: 1 });
  });

  it('keeps a mission edited in OpenFleet, copied law included, and reports a conflict', () => {
    makeStoredMissionTheOneAnEarlierImportWrote(OLD_MISSION_WITH_COPIED_LAW);
    const editedMission = `${OLD_MISSION_WITH_COPIED_LAW}\n\nAdded by hand.`;
    withTarget((db) => db.prepare('UPDATE managers SET mission_text = ? WHERE session_id = ?').run(editedMission, LEAD_ARGUS_ID));
    const revisionBefore = storedManager().profile_rev;

    const report = run();

    expect(storedManager()).toEqual({ mission_text: editedMission, profile_rev: revisionBefore });
    expect(report.counts.managers).toMatchObject({ conflict: 1, updated: 0 });
  });

  it('keeps the laws table, its keys and its counts as they were', () => {
    const lawsBefore = storedLaws();
    makeStoredMissionTheOneAnEarlierImportWrote(OLD_MISSION_WITH_COPIED_LAW);

    const report = run();

    expect(storedLaws()).toEqual(lawsBefore);
    expect(lawsBefore).toEqual([{ source_key: `scape:${LEAD_ARGUS_ID}:law-${LAW_TEXT}`, text: LAW_TEXT, status: 'active', revision: 1 }]);
    expect(report.counts.laws).toMatchObject({ expected: 1, written: 0, updated: 0, alreadyPresent: 1, conflict: 0 });
  });
});
