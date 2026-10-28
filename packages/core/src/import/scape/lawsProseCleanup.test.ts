import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { importScape } from './importScape.js';
import { applyLawsProseCleanup, planLawsProseCleanup, type LawsProseCleanupReport } from './lawsProseCleanup.js';
import { anApprovedLaw, anApprovedPermission, anArgus, CAPTAIN_ARGUS_ID, LEAD_ARGUS_ID, writeArguses } from './scapeArguses.testkit.js';
import { buildScapeFixture, type ScapeFixture } from './scapeFixture.testkit.js';
import { hashOfValues } from './scapeLedger.js';
import { ScapeImportError } from './scapeImportError.js';
import { openWritableTarget } from './scapeTarget.js';

const LAW_ONE = 'Invented law one.';
const LAW_TWO = 'Invented law two.\nSecond line of law two.';
const PERMISSION = 'Invented permission.';
const NOTE_PROSE = '# Rules\n\nbe kind';
const STANDING_BLOCK = `### Standing laws\n- ${LAW_ONE}\n- Invented law two.\n  Second line of law two.`;
const PERMISSIONS_BLOCK = `### Permissions\n- ${PERMISSION}`;
const EXPOSED_BLOCK = '## Exposed Resources\n- @playbook:p-1 (run)';

const legacyMission = (parts: string[]) => parts.join('\n\n');
const MISSION_WITH_PERMISSIONS = legacyMission([NOTE_PROSE, '## Laws', STANDING_BLOCK, PERMISSIONS_BLOCK]);
const MISSION_WITHOUT_PERMISSIONS = legacyMission([NOTE_PROSE, '## Laws', STANDING_BLOCK]);

describe('lawsProseCleanup removes the Standing laws copies an earlier import wrote into the missions', () => {
  let fixture: ScapeFixture;
  let home: string;

  const run = () => importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), managersRoot: join(fixture.workDir, 'managers') });
  const withDatabase = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const withdrawLawOneIn = (db: DatabaseSync) => db.prepare("UPDATE laws SET status = 'withdrawn', withdrawn_at = '2026-10-28T00:00:00.000Z', withdrawn_by = 'tester' WHERE text = ?").run(LAW_ONE);
  const withdrawLawOne = () => withDatabase(withdrawLawOneIn);
  const plan = () => withDatabase((db) => planLawsProseCleanup(db));
  const apply = (confirm: string | undefined) => {
    const target = openWritableTarget(home);
    try {
      return applyLawsProseCleanup({ db: target.db, home, confirm });
    } finally {
      target.dispose();
    }
  };
  const confirmedApply = () => apply(plan().fingerprint);
  const storedManager = (managerId = LEAD_ARGUS_ID) =>
    withDatabase((db) => db.prepare('SELECT mission_text, profile_rev FROM managers WHERE session_id = ?').get(managerId) as { mission_text: string; profile_rev: number });
  const storedLedger = () => withDatabase((db) => db.prepare('SELECT kind, id, record_hash FROM scape_import_ledger ORDER BY kind, id').all());
  const storedLaws = () => withDatabase((db) => db.prepare('SELECT source_key, text, status, revision FROM laws ORDER BY source_key').all());
  const backupFiles = () => (existsSync(join(home, 'backups')) ? readdirSync(join(home, 'backups')) : []);
  const makeStoredMissionTheOneAnEarlierImportWrote = (missionText: string, managerId = LEAD_ARGUS_ID) =>
    withDatabase((db) => {
      const stored = db.prepare('SELECT pulse_seconds, children_cap FROM managers WHERE session_id = ?').get(managerId) as { pulse_seconds: number; children_cap: number };
      const model = (db.prepare('SELECT model FROM sessions WHERE id = ?').get(managerId) as { model: string | null }).model;
      db.prepare('UPDATE managers SET mission_text = ? WHERE session_id = ?').run(missionText, managerId);
      const hashOfEarlierImport = hashOfValues({ mission_text: missionText, pulse_seconds: stored.pulse_seconds, children_cap: stored.children_cap, model });
      db.prepare("UPDATE scape_import_ledger SET record_hash = ? WHERE kind = 'manager' AND id = ?").run(hashOfEarlierImport, managerId);
    });
  const aLeadWithTheTwoLaws = () => anArgus({
    governanceRequests: [anApprovedLaw(LAW_ONE), anApprovedLaw(LAW_TWO, 811_100_050), anApprovedPermission({ text: PERMISSION, scope: '', condition: '', exclusions: '' })],
  });

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    writeArguses(fixture, [aLeadWithTheTwoLaws()]);
    run();
  });

  describe('the plan', () => {
    it('counts the removable copies and the bytes saved, and writes nothing', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS);
      const managerBefore = storedManager();
      const ledgerBefore = storedLedger();
      const lawsBefore = storedLaws();

      const { report } = plan();

      const standingBlockBytes = Buffer.byteLength(`${STANDING_BLOCK}\n\n`);
      expect(report).toMatchObject({ managersToClean: 1, removableCopies: 2, bytesSaved: standingBlockBytes, conflicts: 0 });
      expect(storedManager()).toEqual(managerBefore);
      expect(storedLedger()).toEqual(ledgerBefore);
      expect(storedLaws()).toEqual(lawsBefore);
      expect(backupFiles()).toEqual([]);
    });

    it('gives the same fingerprint for the same state and another one once the state differs', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS);
      const fingerprint = plan().fingerprint;
      const fingerprintAgain = plan().fingerprint;
      withdrawLawOne();

      const fingerprintAfterAChange = plan().fingerprint;

      expect(fingerprintAgain).toBe(fingerprint);
      expect(fingerprintAfterAChange).not.toBe(fingerprint);
    });
  });

  describe('the application', () => {
    it('removes the exact Standing laws block and keeps `## Laws` while Permissions remain', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS);
      const revisionBefore = storedManager().profile_rev;

      apply(plan().fingerprint);

      expect(storedManager()).toEqual({ mission_text: legacyMission([NOTE_PROSE, '## Laws', PERMISSIONS_BLOCK]), profile_rev: revisionBefore + 1 });
    });

    it('removes `## Laws` with the block when no Permissions remain', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITHOUT_PERMISSIONS);

      confirmedApply();

      expect(storedManager().mission_text).toBe(NOTE_PROSE);
    });

    it('keeps the Exposed Resources that follow the removed block', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(legacyMission([NOTE_PROSE, '## Laws', STANDING_BLOCK, EXPOSED_BLOCK]));

      confirmedApply();

      expect(storedManager().mission_text).toBe(legacyMission([NOTE_PROSE, EXPOSED_BLOCK]));
    });

    it('leaves a mission made of the block alone empty', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(legacyMission(['## Laws', STANDING_BLOCK, EXPOSED_BLOCK]));

      confirmedApply();

      expect(storedManager().mission_text).toBe(EXPOSED_BLOCK);
    });

    it.each([
      ['withdrawn', (db: DatabaseSync) => withdrawLawOneIn(db)],
      ['edited', (db: DatabaseSync) => db.prepare('UPDATE laws SET text = ? WHERE text = ?').run('Invented law one, reworded.', LAW_ONE)],
      ['deleted', (db: DatabaseSync) => db.prepare('DELETE FROM laws WHERE text = ?').run(LAW_ONE)],
    ])('keeps the whole copy and counts it for a manual review when a law is %s in the laws table', (_state, changeTheLaw) => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS);
      withDatabase(changeTheLaw);
      const managerBefore = storedManager();

      const { report } = plan();
      apply(plan().fingerprint);

      expect(report).toMatchObject({ managersToClean: 0, removableCopies: 0, bytesSaved: 0, copiesToReviewByHand: { unrecognizedStandingLaws: 2 } });
      expect(storedManager()).toEqual(managerBefore);
    });

    it('never touches the prose of the note: a second Laws and a Guardrails section are only counted', () => {
      const handWrittenProse = `${NOTE_PROSE}\n\n## Laws\n\n- ${LAW_ONE}\n\n## Guardrails\n\n- ${LAW_ONE}`;
      makeStoredMissionTheOneAnEarlierImportWrote(legacyMission([handWrittenProse, '## Laws', STANDING_BLOCK, PERMISSIONS_BLOCK]));

      const { report } = plan();
      apply(plan().fingerprint);

      expect(storedManager().mission_text).toBe(legacyMission([handWrittenProse, '## Laws', PERMISSIONS_BLOCK]));
      expect(report.copiesToReviewByHand).toMatchObject({ lawsSectionsInNotes: 1, guardrailsSectionsInNotes: 1, unrecognizedStandingLaws: 0 });
    });

    it('counts the hand-written sections of a manager that has no Standing laws block', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(legacyMission([`${NOTE_PROSE}\n\n## Guardrails\n\n- keep it`, '## Laws', PERMISSIONS_BLOCK]));

      const { report } = plan();

      expect(report).toMatchObject({ managersToClean: 0, copiesToReviewByHand: { lawsSectionsInNotes: 0, guardrailsSectionsInNotes: 1 } });
    });

    it('does nothing on the second pass', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS);
      confirmedApply();
      const managerAfterTheFirstPass = storedManager();
      const ledgerAfterTheFirstPass = storedLedger();
      const backupsAfterTheFirstPass = backupFiles();

      const report = confirmedApply();

      expect(report).toMatchObject({ managersToClean: 0, removableCopies: 0, bytesSaved: 0 });
      expect(storedManager()).toEqual(managerAfterTheFirstPass);
      expect(storedLedger()).toEqual(ledgerAfterTheFirstPass);
      expect(backupFiles()).toEqual(backupsAfterTheFirstPass);
    });

    it('reports a conflict and writes nothing for a mission edited in OpenFleet', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS);
      const editedMission = `${MISSION_WITH_PERMISSIONS}\n\nAdded by hand.`;
      withDatabase((db) => db.prepare('UPDATE managers SET mission_text = ? WHERE session_id = ?').run(editedMission, LEAD_ARGUS_ID));
      const ledgerBefore = storedLedger();

      const report = confirmedApply();

      expect(report).toMatchObject({ conflicts: 1, managersToClean: 0, removableCopies: 0 });
      expect(storedManager().mission_text).toBe(editedMission);
      expect(storedLedger()).toEqual(ledgerBefore);
      expect(backupFiles()).toEqual([]);
    });

    it('leaves the ledger so that the next import finds the manager already present', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS);
      confirmedApply();
      const managerAfterTheCleanup = storedManager();

      const importReport = run();

      expect(importReport.counts.managers).toMatchObject({ alreadyPresent: 1, updated: 0, conflict: 0, written: 0 });
      expect(storedManager()).toEqual(managerAfterTheCleanup);
    });

    it('leaves the ledger as the common ancestor: a later change in Scape is applied, not reported as a conflict', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS);
      confirmedApply();
      writeArguses(fixture, [{ ...aLeadWithTheTwoLaws(), pulseInterval: 900 }]);

      const importReport = run();

      expect(importReport.counts.managers).toMatchObject({ updated: 1, conflict: 0 });
    });

    it('leaves the laws table as it was', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS);
      const lawsBefore = storedLaws();

      confirmedApply();

      expect(storedLaws()).toEqual(lawsBefore);
    });

    it('backs the database up before writing', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS);

      confirmedApply();

      const [backupFile] = backupFiles();
      expect(backupFiles()).toHaveLength(1);
      expect(statSync(join(home, 'backups', backupFile!)).size).toBeGreaterThan(0);
      const backup = new DatabaseSync(join(home, 'backups', backupFile!), { readOnly: true });
      try {
        const missionInTheBackup = (backup.prepare('SELECT mission_text FROM managers WHERE session_id = ?').get(LEAD_ARGUS_ID) as { mission_text: string }).mission_text;
        expect(missionInTheBackup).toBe(MISSION_WITH_PERMISSIONS);
      } finally {
        backup.close();
      }
    });

    it('rolls every manager back when one write fails', () => {
      writeArguses(fixture, [aLeadWithTheTwoLaws(), anArgus({ id: CAPTAIN_ARGUS_ID, name: 'Beta', governanceRequests: [anApprovedLaw(LAW_ONE)] })]);
      run();
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS, LEAD_ARGUS_ID);
      makeStoredMissionTheOneAnEarlierImportWrote(legacyMission([NOTE_PROSE, '## Laws', `### Standing laws\n- ${LAW_ONE}`]), CAPTAIN_ARGUS_ID);
      withDatabase((db) => db.exec(`CREATE TRIGGER failing_write BEFORE UPDATE ON managers WHEN NEW.session_id = '${CAPTAIN_ARGUS_ID}' BEGIN SELECT RAISE(ABORT, 'boom'); END`));
      const leadBefore = storedManager(LEAD_ARGUS_ID);
      const ledgerBefore = storedLedger();

      expect(() => confirmedApply()).toThrow();

      expect(storedManager(LEAD_ARGUS_ID)).toEqual(leadBefore);
      expect(storedLedger()).toEqual(ledgerBefore);
    });
  });

  describe('the confirmation', () => {
    const refusalOf = (confirm: string | undefined): ScapeImportError | undefined => {
      try {
        apply(confirm);
        return undefined;
      } catch (error) {
        return error as ScapeImportError;
      }
    };
    const expectRefusedAndNothingWritten = (confirm: string | undefined) => {
      const managerBefore = storedManager();
      const ledgerBefore = storedLedger();

      const refusal = refusalOf(confirm);

      expect(refusal).toBeInstanceOf(ScapeImportError);
      expect(refusal!.code).toBe('CLEANUP_NOT_CONFIRMED');
      expect(storedManager()).toEqual(managerBefore);
      expect(storedLedger()).toEqual(ledgerBefore);
      expect(backupFiles()).toEqual([]);
    };

    beforeEach(() => makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS));

    it('refuses an application with no fingerprint', () => {
      expectRefusedAndNothingWritten(undefined);
    });

    it('refuses an application with a wrong fingerprint', () => {
      expectRefusedAndNothingWritten('not-the-fingerprint');
    });

    it('refuses the fingerprint of a plan the state has moved away from', () => {
      const fingerprintOfTheShownPlan = plan().fingerprint;
      withdrawLawOne();

      expectRefusedAndNothingWritten(fingerprintOfTheShownPlan);
    });

    it('does not print the expected fingerprint in the refusal', () => {
      const { fingerprint } = plan();

      const refusal = refusalOf('wrong');

      expect(refusal!.message).not.toContain(fingerprint);
    });
  });

  describe('what it prints', () => {
    const everythingPrintedBy = (report: LawsProseCleanupReport) => JSON.stringify(report);

    it('holds counts only: no law text in the plan, the application nor the refusal', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(legacyMission([`${NOTE_PROSE}\n\n## Laws\n\n- ${LAW_ONE}`, '## Laws', STANDING_BLOCK, PERMISSIONS_BLOCK]));
      const planned = plan();
      const refusal = (() => { try { apply('wrong'); } catch (error) { return (error as Error).message; } return ''; })();
      const applied = apply(planned.fingerprint);

      const printed = [everythingPrintedBy(planned.report), everythingPrintedBy(applied), refusal, planned.fingerprint].join('\n');

      for (const lawText of [LAW_ONE, 'Invented law two', 'Second line', PERMISSION]) expect(printed).not.toContain(lawText);
    });

    it('prints only numbers in the report', () => {
      makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_PERMISSIONS);

      const { report } = plan();

      const leaves: unknown[] = [];
      const collect = (value: unknown): void => (typeof value === 'object' && value !== null ? Object.values(value).forEach(collect) : void leaves.push(value));
      collect(report);
      expect(leaves.every((leaf) => typeof leaf === 'number')).toBe(true);
    });
  });
});
