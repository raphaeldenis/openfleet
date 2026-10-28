import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { runImportCli } from './importCli.js';
import { anApprovedLaw, anApprovedPermission, anArgus, LEAD_ARGUS_ID, writeArguses } from './scape/scapeArguses.testkit.js';
import { buildScapeFixture, type ScapeFixture } from './scape/scapeFixture.testkit.js';
import { hashOfValues } from './scape/scapeLedger.js';

const LAW_ONE = 'Invented law one.';
const LAW_TWO = 'Invented law two.\nSecond line of law two.';
const PERMISSION = 'Invented permission.';
const NOTE_PROSE = '# Rules\n\nbe kind';
const STANDING_BLOCK = `### Standing laws\n- ${LAW_ONE}\n- Invented law two.\n  Second line of law two.`;
const PERMISSIONS_BLOCK = `### Permissions\n- ${PERMISSION}`;
const MISSION_WITH_STANDING_BLOCK = [NOTE_PROSE, '## Laws', STANDING_BLOCK, PERMISSIONS_BLOCK].join('\n\n');
const MISSION_WITHOUT_STANDING_BLOCK = [NOTE_PROSE, '## Laws', PERMISSIONS_BLOCK].join('\n\n');
const LAW_FRAGMENTS = [LAW_ONE, 'Invented law two', 'Second line', PERMISSION];

describe('import scape clean-laws', () => {
  let fixture: ScapeFixture;
  let home: string;
  let homeDirectory: string;
  const environment = () => ({ homeDirectory, env: {} });
  const importScapeIntoHome = () => runImportCli(['scape', '--home', home, '--scape-dir', fixture.scapeDir], environment());
  const cleanLaws = (...flags: string[]) => runImportCli(['scape', 'clean-laws', '--home', home, ...flags], environment());
  const withDatabase = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const storedMission = () => withDatabase((db) => (db.prepare('SELECT mission_text FROM managers WHERE session_id = ?').get(LEAD_ARGUS_ID) as { mission_text: string }).mission_text);
  const backupFiles = () => (existsSync(join(home, 'backups')) ? readdirSync(join(home, 'backups')) : []);
  const makeStoredMissionTheOneAnEarlierImportWrote = (missionText: string) =>
    withDatabase((db) => {
      const stored = db.prepare('SELECT pulse_seconds, children_cap FROM managers WHERE session_id = ?').get(LEAD_ARGUS_ID) as { pulse_seconds: number; children_cap: number };
      const model = (db.prepare('SELECT model FROM sessions WHERE id = ?').get(LEAD_ARGUS_ID) as { model: string | null }).model;
      db.prepare('UPDATE managers SET mission_text = ? WHERE session_id = ?').run(missionText, LEAD_ARGUS_ID);
      const hashOfEarlierImport = hashOfValues({ mission_text: missionText, pulse_seconds: stored.pulse_seconds, children_cap: stored.children_cap, model });
      db.prepare("UPDATE scape_import_ledger SET record_hash = ? WHERE kind = 'manager' AND id = ?").run(hashOfEarlierImport, LEAD_ARGUS_ID);
    });
  const fingerprintOfThePlan = () => {
    const fingerprint = /Fingerprint: (\w+)/.exec(cleanLaws().output)?.[1];
    expect(fingerprint).toBeDefined();
    return fingerprint!;
  };

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    homeDirectory = join(fixture.workDir, 'user-home');
    mkdirSync(join(homeDirectory, 'Documents', 'superpowers'), { recursive: true });
    writeArguses(fixture, [anArgus({ governanceRequests: [anApprovedLaw(LAW_ONE), anApprovedLaw(LAW_TWO, 811_100_050), anApprovedPermission({ text: PERMISSION, scope: '', condition: '', exclusions: '' })] })]);
    importScapeIntoHome();
    makeStoredMissionTheOneAnEarlierImportWrote(MISSION_WITH_STANDING_BLOCK);
  });

  describe('by default', () => {
    it('prints the plan with its fingerprint and writes nothing', () => {
      const result = cleanLaws();

      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/managers to clean: 1\b/);
      expect(result.output).toMatch(/removable copies: 2\b/);
      expect(result.output).toMatch(/Fingerprint: [0-9a-f]{64}/);
      expect(storedMission()).toBe(MISSION_WITH_STANDING_BLOCK);
      expect(backupFiles()).toEqual([]);
    });

    it('refuses a home that holds no database and creates nothing', () => {
      home = join(fixture.workDir, 'empty-home');

      const result = cleanLaws();

      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('INVALID_ARGUMENTS');
      expect(existsSync(home)).toBe(false);
    });
  });

  describe('with --apply', () => {
    it('refuses without --confirm, tells to read the plan again and writes nothing', () => {
      const expectedFingerprint = fingerprintOfThePlan();

      const result = cleanLaws('--apply');

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('CLEANUP_NOT_CONFIRMED');
      expect(result.output).toMatch(/preview the plan/i);
      expect(result.output).not.toContain(expectedFingerprint);
      expect(storedMission()).toBe(MISSION_WITH_STANDING_BLOCK);
      expect(backupFiles()).toEqual([]);
    });

    it('refuses a wrong fingerprint without revealing the expected one and writes nothing', () => {
      const expectedFingerprint = fingerprintOfThePlan();

      const result = cleanLaws('--apply', '--confirm', 'not-the-fingerprint');

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('CLEANUP_NOT_CONFIRMED');
      expect(result.output).not.toContain(expectedFingerprint);
      expect(storedMission()).toBe(MISSION_WITH_STANDING_BLOCK);
      expect(backupFiles()).toEqual([]);
    });

    it('cleans the missions and backs the database up with the fingerprint of the plan', () => {
      const result = cleanLaws('--apply', '--confirm', fingerprintOfThePlan());

      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/managers to clean: 1\b/);
      expect(storedMission()).toBe(MISSION_WITHOUT_STANDING_BLOCK);
      expect(backupFiles()).toHaveLength(1);
    });

    it('does nothing on a second run', () => {
      cleanLaws('--apply', '--confirm', fingerprintOfThePlan());
      const missionAfterTheFirstRun = storedMission();
      const backupsAfterTheFirstRun = backupFiles();

      const result = cleanLaws('--apply', '--confirm', fingerprintOfThePlan());

      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/managers to clean: 0\b/);
      expect(storedMission()).toBe(missionAfterTheFirstRun);
      expect(backupFiles()).toEqual(backupsAfterTheFirstRun);
    });

    it('is refused while another process holds the database, and writes nothing', () => {
      const fingerprint = fingerprintOfThePlan();
      const daemonConnection = new DatabaseSync(join(home, 'openfleet.db'));
      daemonConnection.exec('PRAGMA journal_mode = WAL');
      daemonConnection.prepare('SELECT count(*) FROM managers').get();

      try {
        const result = cleanLaws('--apply', '--confirm', fingerprint);

        expect(result.exitCode).toBe(1);
        expect(result.output).toContain('DAEMON_RUNNING');
      } finally {
        daemonConnection.close();
      }
      expect(storedMission()).toBe(MISSION_WITH_STANDING_BLOCK);
      expect(backupFiles()).toEqual([]);
    });
  });

  describe('--json', () => {
    it('prints the plan with its fingerprint', () => {
      const printed = JSON.parse(cleanLaws('--json').output);

      expect(printed).toMatchObject({ mode: 'plan', report: { managersToClean: 1, removableCopies: 2, conflicts: 0 } });
      expect(printed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(storedMission()).toBe(MISSION_WITH_STANDING_BLOCK);
    });

    it('prints the applied report without any fingerprint', () => {
      const printed = JSON.parse(cleanLaws('--apply', '--confirm', fingerprintOfThePlan(), '--json').output);

      expect(printed).toMatchObject({ mode: 'apply', report: { managersToClean: 1 } });
      expect(printed).not.toHaveProperty('fingerprint');
    });

    it('leaves the JSON of the import as it was', () => {
      const printed = JSON.parse(runImportCli(['scape', '--home', home, '--scape-dir', fixture.scapeDir, '--dry-run', '--json'], environment()).output);

      expect(Object.keys(printed)).toEqual(expect.arrayContaining(['dryRun', 'counts', 'laws']));
      expect(printed).not.toHaveProperty('mode');
      expect(printed).not.toHaveProperty('fingerprint');
    });
  });

  describe('what it prints', () => {
    it('holds no law text in the plan, the refusal, the application nor the JSON', () => {
      const fingerprint = fingerprintOfThePlan();

      const printed = [cleanLaws(), cleanLaws('--json'), cleanLaws('--apply'), cleanLaws('--apply', '--confirm', 'wrong'), cleanLaws('--apply', '--confirm', fingerprint), cleanLaws('--apply', '--confirm', fingerprint, '--json')]
        .map(({ output }) => output)
        .join('\n');

      for (const fragment of LAW_FRAGMENTS) expect(printed).not.toContain(fragment);
    });
  });

  describe('the arguments', () => {
    it('rejects --confirm without --apply', () => {
      const result = cleanLaws('--confirm', 'anything');

      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('INVALID_ARGUMENTS');
    });

    it('rejects --apply on the import itself', () => {
      const result = runImportCli(['scape', '--home', home, '--scape-dir', fixture.scapeDir, '--apply'], environment());

      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('INVALID_ARGUMENTS');
    });

    it('lists the command in the usage', () => {
      const result = runImportCli(['--help'], environment());

      expect(result.output).toContain('clean-laws');
      expect(result.output).toContain('--apply');
      expect(result.output).toContain('--confirm');
    });
  });
});
