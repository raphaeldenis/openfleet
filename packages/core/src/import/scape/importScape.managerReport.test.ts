import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runImportCli } from '../importCli.js';
import { importScape } from './importScape.js';
import { anApprovedPermission, anArgus, CAPTAIN_ARGUS_ID, LEAD_ARGUS_ID, writeArguses } from './scapeArguses.testkit.js';
import { buildScapeFixture, editScapeNotes, LEXICAL_NOTE_ID, MARKDOWN_NOTE_ID, OPENFLEET_NOTE_ID, PLAN_NOTE_ID, REPORT_NOTE_ID, type ScapeFixture } from './scapeFixture.testkit.js';

const CLEAN_ID = LEAD_ARGUS_ID;
const BIG_ID = 'A0000003-0000-0000-0000-000000000003';
const CAP_ID = 'A0000004-0000-0000-0000-000000000004';
const MODEL_ID = 'A0000005-0000-0000-0000-000000000005';
const QA_ID = CAPTAIN_ARGUS_ID;
const DUPLICATE_ID = 'A0000006-0000-0000-0000-000000000006';

const CLEAN_MISSION = '# Rules\n\nbe kind';
const BIG_PERMISSION = 'é'.repeat(4500);
const BIG_MISSION = `${CLEAN_MISSION}\n\n## Laws\n\n### Permissions\n- ${BIG_PERMISSION}`;
const CAP_MISSION = ['# Plan', 'Spawn up to 8 children at once.', 'Stay at cap of 3.', 'Count the children of your peers.'].join('\n');
const MODEL_MISSION = ['# Arbitration','Use claude-opus-5-5 to arbitrate.', 'Use claude-haiku-5-5 to edit, and claude-opus-5-5 again.', 'Prefer the alias sonnet.'].join('\n');
const QA_MISSION = ['# Review flow',"QA is the human's job.", "Le travail de l'humain reste la QA.", 'Run the automated QA first.'].join('\n');
const DUPLICATE_MISSION = ['# Alpha mission', '', '## Pulse loop', 'Look at the status.', '', '## Escalation ladder', 'Ask the arbiter.', '', '### Shell hygiene', 'One command.', '', '## Project expertise', 'Know the catalog.'].join('\n');

describe('import scape --dry-run: the report of the manager missions', () => {
  let fixture: ScapeFixture;
  let home: string;
  let homeDirectory: string;

  const setNoteContent = (noteId: string, content: string) => editScapeNotes(fixture, (db) => db.prepare('UPDATE notes SET content = ? WHERE id = ?').run(content, noteId));
  const dryRun = () => importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), managersRoot: join(fixture.workDir, 'managers'), dryRun: true });
  const lineOf = (managerId: string) => dryRun().managerMissions.find((line) => line.managerId === managerId)!;

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    homeDirectory = join(fixture.workDir, 'user-home');
    setNoteContent(PLAN_NOTE_ID, CAP_MISSION);
    setNoteContent(REPORT_NOTE_ID, MODEL_MISSION);
    setNoteContent(OPENFLEET_NOTE_ID, QA_MISSION);
    setNoteContent(LEXICAL_NOTE_ID, DUPLICATE_MISSION);
    writeArguses(fixture, [
      anArgus({ id: CLEAN_ID, name: 'Clean', noteId: MARKDOWN_NOTE_ID }),
      anArgus({ id: BIG_ID, name: 'Big', noteId: MARKDOWN_NOTE_ID, governanceRequests: [anApprovedPermission({ text: BIG_PERMISSION, scope: '', condition: '', exclusions: '' })] }),
      anArgus({ id: CAP_ID, name: 'Cap', noteId: PLAN_NOTE_ID }),
      anArgus({ id: MODEL_ID, name: 'Model', noteId: REPORT_NOTE_ID }),
      anArgus({ id: QA_ID, name: 'Qa', noteId: OPENFLEET_NOTE_ID }),
      anArgus({ id: DUPLICATE_ID, name: 'Duplicate', noteId: LEXICAL_NOTE_ID }),
    ]);
  });

  it('gives one line per imported manager, in the order of arguses.json', () => {
    expect(dryRun().managerMissions.map((line) => line.name)).toEqual(['Clean', 'Big', 'Cap', 'Model', 'Qa', 'Duplicate']);
  });

  it('reports a clean mission with its size and nothing to flag', () => {
    expect(lineOf(CLEAN_ID)).toEqual({
      managerId: CLEAN_ID, name: 'Clean', bytes: Buffer.byteLength(CLEAN_MISSION, 'utf8'), isLegacyMission: false,
      numberedChildrenCaps: [], exactModelIds: [], humanQaPhrases: [], baseSectionDuplicates: [],
    });
  });

  it('measures the size in UTF-8 bytes and flags a mission over 8192 bytes as legacy', () => {
    const line = lineOf(BIG_ID);

    expect(line.bytes).toBe(Buffer.byteLength(BIG_MISSION, 'utf8'));
    expect(BIG_MISSION.length).toBeLessThan(8192);
    expect(line.isLegacyMission).toBe(true);
  });

  it('lists the lines that state a number of children', () => {
    expect(lineOf(CAP_ID).numberedChildrenCaps).toEqual(['Spawn up to 8 children at once.', 'Stay at cap of 3.']);
  });

  it('lists each exact model id once, in order of appearance', () => {
    expect(lineOf(MODEL_ID).exactModelIds).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
  });

  it('lists the lines that make the QA the job of the human', () => {
    expect(lineOf(QA_ID).humanQaPhrases).toEqual(["QA is the human's job.", "Le travail de l'humain reste la QA."]);
  });

  it('lists the headings that repeat a section of the base, by section id, and keeps the project headings out', () => {
    expect(lineOf(DUPLICATE_ID).baseSectionDuplicates).toEqual([
      { sectionId: '§2', heading: 'Pulse loop' },
      { sectionId: '§6', heading: 'Escalation ladder' },
      { sectionId: '§9', heading: 'Shell hygiene' },
    ]);
  });

  it('flags one manager only for what its own mission holds', () => {
    const flagged = (line: ReturnType<typeof lineOf>) => [line.numberedChildrenCaps, line.exactModelIds, line.humanQaPhrases, line.baseSectionDuplicates].filter((list) => list.length > 0).length;

    expect([CLEAN_ID, BIG_ID, CAP_ID, MODEL_ID, QA_ID, DUPLICATE_ID].map((id) => flagged(lineOf(id)))).toEqual([0, 0, 1, 1, 1, 1]);
  });

  describe('through the command', () => {
    const argv = (...flags: string[]) => ['scape', '--home', home, '--scape-dir', fixture.scapeDir, '--dry-run', ...flags];
    const run = (...flags: string[]) => runImportCli(argv(...flags), { homeDirectory, env: {} });

    it('prints the lines for a human, one section per manager that has something to flag', () => {
      const { output } = run();

      expect(output).toContain('## Manager missions');
      expect(output).toContain('| Clean | 16 | no |');
      expect(output).toContain('| Big | 9045 | yes |');
      expect(output).toContain('Cap — number of children: Spawn up to 8 children at once.');
      expect(output).toContain('Model — exact model id: claude-opus-5-5');
      expect(output).toContain("Qa — QA for the human: QA is the human's job.");
      expect(output).toContain('Duplicate — repeats §6 of the base: Escalation ladder');
    });

    it('prints the same lines as JSON with --json', () => {
      const { output } = run('--json');

      const printed = JSON.parse(output) as { dryRun: boolean; managerMissions: { managerId: string; bytes: number }[] };
      expect(printed.dryRun).toBe(true);
      expect(printed.managerMissions.map((line) => line.managerId)).toEqual([CLEAN_ID, BIG_ID, CAP_ID, MODEL_ID, QA_ID, DUPLICATE_ID]);
      expect(printed.managerMissions[1]!.bytes).toBe(Buffer.byteLength(BIG_MISSION, 'utf8'));
    });

    it('writes nothing, not even the report file or the home', () => {
      run();
      run('--json');

      expect(existsSync(home)).toBe(false);
      expect(existsSync(join(fixture.workDir, 'managers'))).toBe(false);
    });

    it('leaves an already imported database byte for byte as it was', () => {
      runImportCli(['scape', '--home', home, '--scape-dir', fixture.scapeDir], { homeDirectory, env: {} });
      const databaseBefore = readFileSync(join(home, 'openfleet.db'));
      setNoteContent(PLAN_NOTE_ID, `${CAP_MISSION}\nMore than 9 children.`);

      const { output } = run();

      expect(output).toContain('More than 9 children.');
      expect(readFileSync(join(home, 'openfleet.db')).equals(databaseBefore)).toBe(true);
    });
  });
});
