import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importScape } from './importScape.js';
import {
  aDeniedLaw, aGrant, anApprovedLaw, anApprovedPermission, anApprovedResourceAccess, anArgus, aPendingLaw, CAPTAIN_ARGUS_ID, LEAD_ARGUS_ID, writeArguses,
} from './scapeArguses.testkit.js';
import { BACKLOG_STORE_ID, buildScapeFixture, LEXICAL_NOTE_ID, MARKDOWN_NOTE_ID, OPENFLEET_NOTE_ID, type ScapeFixture } from './scapeFixture.testkit.js';

interface SessionRow { id: string; name: string; emoji: string; directory: string; model: string | null; role: string; harness: string; state: string; project_id: string; created_at: string }
interface ManagerRow { session_id: string; pulse_seconds: number; children_cap: number; mission_text: string; last_pulse_at: string | null }

describe('importScape: managers', () => {
  let fixture: ScapeFixture;
  let home: string;
  let managersRoot: string;
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
    return importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), managersRoot, ...overrides });
  };
  const sessionOf = (id: string) => openTarget().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
  const managerOf = (id: string) => openTarget().prepare('SELECT * FROM managers WHERE session_id = ?').get(id) as unknown as ManagerRow | undefined;
  const missionOf = (id: string) => managerOf(id)!.mission_text;
  const countOf = (table: string) => (openTarget().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    managersRoot = join(fixture.workDir, 'managers');
  });

  describe('a manager', () => {
    it('becomes a closed manager session under the Scape id with its pulse and cap, ready to be started fresh', () => {
      writeArguses(fixture, [anArgus({ name: 'Alpha', pulseInterval: 1440, childrenCap: 2 })]);

      run();

      expect(sessionOf(LEAD_ARGUS_ID)).toMatchObject({
        id: LEAD_ARGUS_ID, name: 'Alpha', role: 'manager', harness: 'claude-cli', state: 'closed', directory: join(managersRoot, 'Alpha'),
        project_id: expect.any(String), created_at: '2026-09-14T14:45:11.900Z',
      });
      expect(managerOf(LEAD_ARGUS_ID)).toMatchObject({ pulse_seconds: 1440, children_cap: 2, last_pulse_at: null });
    });

    it('carries no transcript, resume id or other Scape session state', () => {
      writeArguses(fixture, [anArgus()]);

      run();

      const db = openTarget();
      const stored = JSON.stringify([db.prepare('SELECT * FROM sessions').all(), db.prepare('SELECT * FROM managers').all()]);
      expect(stored).not.toContain('resume-me-not');
      expect((db.prepare('SELECT cli_session_id FROM sessions WHERE id = ?').get(LEAD_ARGUS_ID) as { cli_session_id: string | null }).cli_session_id).toBeNull();
    });

    it('belongs to the project of its mission note', () => {
      writeArguses(fixture, [anArgus({ noteId: OPENFLEET_NOTE_ID })]);

      run();

      expect(sessionOf(LEAD_ARGUS_ID)!.project_id).toBe(openTarget().prepare('SELECT project_id FROM notes WHERE id = ?').get(OPENFLEET_NOTE_ID)!.project_id);
    });

    it.each([
      ['claude-opus-5-5', 'opus'],
      ['claude-sonnet-5-5', 'sonnet'],
      ['claude-haiku-4-5-20251001', 'haiku'],
      ['claude-fable-5-1', 'fable'],
      ['sonnet', 'sonnet'],
      ['opus', 'opus'],
    ])('stores the model %s as the alias %s', (scapeModel, alias) => {
      writeArguses(fixture, [anArgus({ model: scapeModel })]);

      run();

      expect(sessionOf(LEAD_ARGUS_ID)!.model).toBe(alias);
    });

    it('stores no model when the Argus names none', () => {
      writeArguses(fixture, [anArgus({ model: undefined })]);

      run();

      expect(sessionOf(LEAD_ARGUS_ID)!.model).toBeNull();
    });

    it('refuses an Argus on a harness OpenFleet does not know with SCAPE_SOURCE_UNREADABLE and writes nothing', () => {
      writeArguses(fixture, [anArgus({ harnessId: 'mystery-harness' })]);

      expect(() => run()).toThrow(expect.objectContaining({ code: 'SCAPE_SOURCE_UNREADABLE' }));
      expect(existsSync(home)).toBe(false);
    });

    it('gives two managers of the same name two different folders', () => {
      writeArguses(fixture, [anArgus({ name: 'Twin' }), anArgus({ id: CAPTAIN_ARGUS_ID, name: 'Twin', noteId: OPENFLEET_NOTE_ID })]);

      run();

      const directories = [LEAD_ARGUS_ID, CAPTAIN_ARGUS_ID].map((id) => sessionOf(id)!.directory);
      expect(new Set(directories).size).toBe(2);
    });

    it('keeps a name that is not a safe folder name inside the managers folder', () => {
      writeArguses(fixture, [anArgus({ name: '../../Evil/Name' })]);

      run();

      const directory = sessionOf(LEAD_ARGUS_ID)!.directory;
      expect(directory.startsWith(`${managersRoot}/`)).toBe(true);
      expect(directory.slice(managersRoot.length + 1)).not.toContain('/');
      expect(directory).not.toContain('..');
    });
  });

  describe('the mission', () => {
    it('is the imported mission note body, then the approved laws and permissions, then the exposed resources', () => {
      writeArguses(fixture, [anArgus({
        governanceRequests: [
          anApprovedLaw('Always log first.', 811_100_000),
          anApprovedLaw('Never push to main.', 811_100_001),
          anApprovedPermission({ text: 'May merge docs PRs.', scope: 'docs only', condition: 'CI green', exclusions: 'releases' }),
        ],
        resourceGrants: [
          aGrant({ resourceType: 'note', resourceId: MARKDOWN_NOTE_ID, access: 'read' }),
          aGrant({ resourceType: 'dataStore', resourceId: BACKLOG_STORE_ID, access: 'readWrite' }),
          aGrant({ resourceType: 'playbook', resourceId: 'play-1', access: 'run' }),
        ],
      })]);

      run();

      expect(missionOf(LEAD_ARGUS_ID)).toBe([
        '# Rules\n\nbe kind',
        '## Laws',
        '### Standing laws\n- Always log first.\n- Never push to main.',
        '### Permissions\n- May merge docs PRs.\n  Permission: docs only / CI green / releases',
        `## Exposed Resources\n- @note:${MARKDOWN_NOTE_ID} (read)\n- @table:${BACKLOG_STORE_ID} (read and write)\n- @playbook:play-1 (run)`,
      ].join('\n\n'));
    });

    it('starts from the markdown the note import wrote, converted lexical included', () => {
      writeArguses(fixture, [anArgus({ noteId: LEXICAL_NOTE_ID })]);

      run();

      const importedBody = (openTarget().prepare('SELECT body_md FROM notes WHERE id = ?').get(LEXICAL_NOTE_ID) as { body_md: string }).body_md;
      expect(importedBody).toContain('lexical hello');
      expect(missionOf(LEAD_ARGUS_ID)).toBe(importedBody);
    });

    it('leaves out the denied and the pending laws and the approved resource access request', () => {
      writeArguses(fixture, [anArgus({
        governanceRequests: [anApprovedLaw('kept law'), aDeniedLaw('denied law'), aPendingLaw('pending law'), anApprovedResourceAccess()],
      })]);

      run();

      const mission = missionOf(LEAD_ARGUS_ID);
      expect(mission).toContain('kept law');
      expect(mission).not.toContain('denied law');
      expect(mission).not.toContain('pending law');
      expect(mission).not.toContain('resourceAccess');
    });

    it('has neither a Laws nor an Exposed Resources section when the Argus has none', () => {
      writeArguses(fixture, [anArgus()]);

      run();

      expect(missionOf(LEAD_ARGUS_ID)).toBe('# Rules\n\nbe kind');
    });

    it('indents the continuation lines of a multi-line law under its bullet', () => {
      writeArguses(fixture, [anArgus({ governanceRequests: [anApprovedLaw('first line\nsecond line')] })]);

      run();

      expect(missionOf(LEAD_ARGUS_ID)).toContain('- first line\n  second line');
    });

    it('lists a grant whose id cannot be written as a mention without a mention', () => {
      writeArguses(fixture, [anArgus({ resourceGrants: [aGrant({ resourceType: 'note', resourceId: 'bad id!', access: 'read' }), aGrant({ resourceType: 'chart', resourceId: 'c-1', access: 'read' })] })]);

      const report = run();

      expect(report.counts.managers).toMatchObject({ written: 1, notConverted: 1 });
      const mission = missionOf(LEAD_ARGUS_ID);
      expect(mission).not.toContain('@note:bad');
      expect(mission).not.toContain('@chart');
      expect(mission).toContain('[not converted: note]');
      expect(mission).toContain('[not converted: chart]');
    });

    it('skips a manager whose mission would exceed the manager size limit and counts it not converted', () => {
      writeArguses(fixture, [anArgus({ governanceRequests: [anApprovedLaw('x'.repeat(70 * 1024))] })]);

      const report = run();

      expect(report.counts.managers).toMatchObject({ expected: 1, written: 0, notConverted: 1 });
      expect(countOf('managers')).toBe(0);
    });
  });

  describe('the report', () => {
    it('counts the managers expected and written, and renders a managers line', () => {
      writeArguses(fixture, [anArgus(), anArgus({ id: CAPTAIN_ARGUS_ID, name: 'Beta', noteId: OPENFLEET_NOTE_ID })]);

      const report = run();

      expect(report.counts.managers).toMatchObject({ expected: 2, written: 2, updated: 0, alreadyPresent: 0, conflict: 0, notConverted: 0 });
      expect(readFileSync(report.reportPath!, 'utf8')).toContain('| managers | 2 | 2 | 0 | 0 | 0 | 0 |');
    });

    it('counts a manager whose mission note is outside the selected project as not converted and writes it nowhere', () => {
      writeArguses(fixture, [anArgus({ noteId: MARKDOWN_NOTE_ID })]);

      const report = run({ projectName: 'OpenFleet' });

      expect(report.counts.managers).toMatchObject({ expected: 1, written: 0, notConverted: 1 });
      expect(countOf('managers')).toBe(0);
    });

    it('expects no manager when there is no arguses.json', () => {
      const report = run();

      expect(report.counts.managers.expected).toBe(0);
      expect(countOf('managers')).toBe(0);
    });

    it('refuses an unreadable arguses.json with SCAPE_SOURCE_UNREADABLE', () => {
      writeArguses(fixture, [anArgus({ pulseInterval: 'soon' })]);

      expect(() => run()).toThrow(expect.objectContaining({ code: 'SCAPE_SOURCE_UNREADABLE' }));
    });
  });

  describe('running again', () => {
    beforeEach(() => writeArguses(fixture, [anArgus({ governanceRequests: [anApprovedLaw('a law')] }), anArgus({ id: CAPTAIN_ARGUS_ID, name: 'Beta', noteId: OPENFLEET_NOTE_ID })]));

    it('writes nothing the second time', () => {
      run();
      const countsAfterFirstRun = [countOf('sessions'), countOf('managers')];

      const report = run();

      expect(report.counts.managers).toMatchObject({ expected: 2, written: 0, updated: 0, alreadyPresent: 2, conflict: 0 });
      expect([countOf('sessions'), countOf('managers')]).toEqual(countsAfterFirstRun);
    });

    it('leaves alone a manager whose mission was edited in OpenFleet and counts it as a conflict', () => {
      run();
      openTarget().prepare('UPDATE managers SET mission_text = ? WHERE session_id = ?').run('edited in OpenFleet', LEAD_ARGUS_ID);

      const report = run();

      expect(missionOf(LEAD_ARGUS_ID)).toBe('edited in OpenFleet');
      expect(report.counts.managers).toMatchObject({ written: 0, alreadyPresent: 1, conflict: 1 });
    });

    it('leaves alone a manager whose pulse or cap was changed in OpenFleet', () => {
      run();
      openTarget().prepare('UPDATE managers SET pulse_seconds = 30, children_cap = 9 WHERE session_id = ?').run(LEAD_ARGUS_ID);

      const report = run();

      expect(managerOf(LEAD_ARGUS_ID)).toMatchObject({ pulse_seconds: 30, children_cap: 9 });
      expect(report.counts.managers.conflict).toBe(1);
    });

    it('does not touch a manager that has been started since: its state and pulse time are not compared', () => {
      run();
      openTarget().prepare(`UPDATE sessions SET state = 'idle' WHERE id = ?`).run(LEAD_ARGUS_ID);
      openTarget().prepare(`UPDATE managers SET last_pulse_at = '2026-10-05T00:00:00.000Z' WHERE session_id = ?`).run(LEAD_ARGUS_ID);

      const report = run();

      expect(report.counts.managers).toMatchObject({ alreadyPresent: 2, conflict: 0 });
    });

    it('leaves alone a session that holds the Argus id without being a manager', () => {
      run();
      const db = openTarget();
      db.prepare('DELETE FROM managers WHERE session_id = ?').run(LEAD_ARGUS_ID);

      const report = run();

      expect(countOf('managers')).toBe(1);
      expect(report.counts.managers).toMatchObject({ written: 0, conflict: 1 });
    });
  });

  describe('the scratch folder', () => {
    beforeEach(() => writeArguses(fixture, [anArgus({ name: 'Alpha' }), anArgus({ id: CAPTAIN_ARGUS_ID, name: 'Beta', noteId: OPENFLEET_NOTE_ID })]));

    it('is created for each manager by a real run, and kept by the next one', () => {
      run();
      run();

      expect(readdirSync(managersRoot).sort()).toEqual(['Alpha', 'Beta']);
    });

    it('defaults to a managers folder in the OpenFleet home', () => {
      importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers') });

      expect(readdirSync(join(home, 'managers')).sort()).toEqual(['Alpha', 'Beta']);
    });

    it('is not created by a dry run, which still reports the managers it would write', () => {
      const report = run({ dryRun: true });

      expect(existsSync(managersRoot)).toBe(false);
      expect(existsSync(home)).toBe(false);
      expect(report.counts.managers).toMatchObject({ expected: 2, written: 2 });
    });
  });

  describe('temporary files', () => {
    it('leaves nothing behind in the scratch root after a real run or a dry run', () => {
      writeArguses(fixture, [anArgus()]);
      const scratchRoot = join(fixture.workDir, 'scratch');
      mkdirSync(scratchRoot);

      run({ scratchRoot });
      run({ scratchRoot, dryRun: true });

      expect(readdirSync(scratchRoot)).toEqual([]);
    });

    it('never modifies arguses.json', () => {
      writeArguses(fixture, [anArgus()]);
      const before = readFileSync(join(fixture.scapeDir, 'arguses.json'), 'utf8');

      run();

      expect(readFileSync(join(fixture.scapeDir, 'arguses.json'), 'utf8')).toBe(before);
      expect(readdirSync(fixture.scapeDir).sort()).toEqual(['arguses.json', 'datastores', 'notes.sqlite']);
    });
  });
});
