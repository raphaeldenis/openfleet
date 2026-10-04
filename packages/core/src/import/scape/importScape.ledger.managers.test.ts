import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { importScape } from './importScape.js';
import { anArgus, LEAD_ARGUS_ID, writeArguses } from './scapeArguses.testkit.js';
import { buildScapeFixture, editScapeNotes, MARKDOWN_NOTE_ID, type ScapeFixture } from './scapeFixture.testkit.js';

const stateFileWith = (todoItem: string) => ['# Alpha state', '', '## Todo', `- ${todoItem}`, ''].join('\n');

describe('importScape re-import of managers and working states against the ledger', () => {
  let fixture: ScapeFixture;
  let home: string;
  let stateDir: string;

  const run = (overrides: Partial<Parameters<typeof importScape>[0]> = {}) =>
    importScape({
      scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), managersRoot: join(fixture.workDir, 'managers'),
      scratchRoot: join(fixture.workDir, 'scratch'), stateDir, ...overrides,
    });
  const withTarget = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const missionOfAlpha = () => withTarget((db) => (db.prepare('SELECT mission_text FROM managers WHERE session_id = ?').get(LEAD_ARGUS_ID) as { mission_text: string } | undefined)?.mission_text);
  const todoOfAlpha = () =>
    withTarget((db) => (JSON.parse((db.prepare('SELECT sections_json FROM session_working_states WHERE session_id = ?').get(LEAD_ARGUS_ID) as { sections_json: string }).sections_json) as { todo: string[] }).todo);
  const changeMissionInScape = () => editScapeNotes(fixture, (db) => db.prepare(`UPDATE notes SET content = '# Mission rewritten in Scape' WHERE id = ?`).run(MARKDOWN_NOTE_ID));
  const writeStateFile = (todoItem: string) => writeFileSync(join(stateDir, 'alpha.md'), stateFileWith(todoItem));

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    stateDir = join(fixture.workDir, 'state');
    mkdirSync(stateDir);
    mkdirSync(join(fixture.workDir, 'scratch'));
    writeArguses(fixture, [anArgus({ name: 'Alpha' })]);
    writeStateFile('first item');
  });

  it('writes nothing on a second run', () => {
    run();

    const report = run();

    expect(report.counts.managers).toMatchObject({ alreadyPresent: 1, written: 0, updated: 0, conflict: 0 });
    expect(report.counts.workingStates).toMatchObject({ alreadyPresent: 1, written: 0, updated: 0, conflict: 0 });
  });

  it('applies a mission changed in Scape to a manager OpenFleet left alone', () => {
    run();
    changeMissionInScape();

    const report = run();

    expect(missionOfAlpha()).toContain('Mission rewritten in Scape');
    expect(report.counts.managers).toMatchObject({ updated: 1, conflict: 0 });
    expect(run().counts.managers).toMatchObject({ alreadyPresent: 1, updated: 0 });
  });

  it('keeps the mission a manager has in OpenFleet when it was edited there', () => {
    run();
    withTarget((db) => db.prepare(`UPDATE managers SET mission_text = 'my mission' WHERE session_id = ?`).run(LEAD_ARGUS_ID));
    changeMissionInScape();

    const report = run();

    expect(missionOfAlpha()).toBe('my mission');
    expect(report.counts.managers).toMatchObject({ conflict: 1, updated: 0 });
  });

  it('does not bring back a manager deleted in OpenFleet', () => {
    run();
    withTarget((db) => {
      db.prepare('DELETE FROM session_working_states WHERE session_id = ?').run(LEAD_ARGUS_ID);
      db.prepare('DELETE FROM managers WHERE session_id = ?').run(LEAD_ARGUS_ID);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(LEAD_ARGUS_ID);
    });

    const report = run();

    expect(missionOfAlpha()).toBeUndefined();
    expect(report.counts.managers).toMatchObject({ conflict: 1, deletedInOpenFleet: 1, written: 0 });
    expect(report.counts.workingStates).toMatchObject({ conflict: 1, written: 0 });
  });

  it('reports a manager removed from Scape and keeps it', () => {
    run();
    writeArguses(fixture, []);

    const report = run();

    expect(missionOfAlpha()).toBeDefined();
    expect(report.counts.managers.removedInScape).toBe(1);
    expect(report.counts.workingStates.removedInScape).toBe(1);
  });

  it('follows the state file while OpenFleet left the working state alone', () => {
    run();
    writeStateFile('second item');

    const report = run();

    expect(todoOfAlpha()).toEqual(['second item']);
    expect(report.counts.workingStates).toMatchObject({ updated: 1, conflict: 0 });
  });

  it('keeps a working state OpenFleet moved on from, as a conflict', () => {
    run();
    withTarget((db) => db.prepare(`UPDATE session_working_states SET sections_json = json_set(sections_json, '$.todo', json('["mine"]')) WHERE session_id = ?`).run(LEAD_ARGUS_ID));
    writeStateFile('second item');

    const report = run();

    expect(todoOfAlpha()).toEqual(['mine']);
    expect(report.counts.workingStates).toMatchObject({ conflict: 1, updated: 0 });
  });

  it('adopts a home imported before the ledger existed', () => {
    run();
    withTarget((db) => db.prepare('DELETE FROM scape_import_ledger').run());

    const report = run();

    expect(report.counts.managers).toMatchObject({ alreadyPresent: 1, conflict: 0 });
    expect(report.counts.workingStates).toMatchObject({ alreadyPresent: 1, conflict: 0 });
    expect(withTarget((db) => (db.prepare(`SELECT count(*) AS n FROM scape_import_ledger WHERE kind IN ('manager', 'working_state')`).get() as { n: number }).n)).toBe(2);
  });
});
