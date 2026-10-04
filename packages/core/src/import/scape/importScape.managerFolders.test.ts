import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importScape } from './importScape.js';
import { anArgus, CAPTAIN_ARGUS_ID, LEAD_ARGUS_ID, writeArguses } from './scapeArguses.testkit.js';
import { buildScapeFixture, OPENFLEET_NOTE_ID, type ScapeFixture } from './scapeFixture.testkit.js';

describe('importScape: manager folders', () => {
  let fixture: ScapeFixture;
  let home: string;
  let managersRoot: string;
  const openConnections: DatabaseSync[] = [];

  afterEach(() => openConnections.splice(0).forEach((db) => db.close()));

  const run = (overrides: Partial<Parameters<typeof importScape>[0]> = {}) => {
    openConnections.splice(0).forEach((db) => db.close());
    return importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), managersRoot, ...overrides });
  };
  const countOf = (table: string) => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    openConnections.push(db);
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  };
  const directoriesOf = (...ids: string[]) => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    openConnections.push(db);
    return ids.map((id) => (db.prepare('SELECT directory FROM sessions WHERE id = ?').get(id) as { directory: string }).directory);
  };
  const aSecondArgus = (overrides: Record<string, unknown> = {}) => anArgus({ id: CAPTAIN_ARGUS_ID, name: 'Beta', noteId: OPENFLEET_NOTE_ID, ...overrides });
  const nothingWasImported = () => {
    expect(countOf('managers')).toBe(0);
    expect(countOf('notes')).toBe(0);
  };

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    managersRoot = join(fixture.workDir, 'managers');
  });

  describe('names and ids', () => {
    it.each(['../escape', 'a/b', '', '.', '..', 'x y', 'ü'])('refuses the Argus id %j with SCAPE_SOURCE_UNREADABLE and writes nothing', (id) => {
      writeArguses(fixture, [anArgus({ id })]);

      expect(() => run()).toThrow(expect.objectContaining({ code: 'SCAPE_SOURCE_UNREADABLE' }));
      expect(existsSync(home)).toBe(false);
      expect(existsSync(managersRoot)).toBe(false);
    });

    it('refuses two Arguses sharing an id', () => {
      writeArguses(fixture, [anArgus(), anArgus({ name: 'Other' })]);

      expect(() => run()).toThrow(expect.objectContaining({ code: 'SCAPE_SOURCE_UNREADABLE' }));
    });

    it('gives Lead and lead two different folders even on a case-insensitive disk', () => {
      writeArguses(fixture, [anArgus({ name: 'Lead' }), aSecondArgus({ name: 'lead' })]);

      run();

      const [first, second] = directoriesOf(LEAD_ARGUS_ID, CAPTAIN_ARGUS_ID);
      expect(first!.toLowerCase()).not.toBe(second!.toLowerCase());
    });

    it('falls back to a safe single-component folder name when the name leaves nothing usable', () => {
      writeArguses(fixture, [anArgus({ name: '...' }), aSecondArgus({ name: '///' })]);

      run();

      const directories = directoriesOf(LEAD_ARGUS_ID, CAPTAIN_ARGUS_ID);
      for (const directory of directories) expect(directory.slice(managersRoot.length + 1)).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/);
      expect(new Set(directories.map((directory) => directory.toLowerCase())).size).toBe(2);
    });

    it('keeps the folder of a manager whose name equals the id prefix of another unique', () => {
      writeArguses(fixture, [anArgus({ name: 'A0000002' }), aSecondArgus({ name: 'A0000002' })]);

      run();

      const directories = directoriesOf(LEAD_ARGUS_ID, CAPTAIN_ARGUS_ID);
      expect(new Set(directories.map((directory) => directory.toLowerCase())).size).toBe(2);
    });
  });

  describe('containment', () => {
    it('refuses a managers root that resolves into the Scape source and writes nothing there or in OpenFleet', () => {
      writeArguses(fixture, [anArgus()]);
      const scapeFilesBefore = readdirSync(fixture.scapeDir).sort();
      const link = join(fixture.workDir, 'link-to-scape');
      symlinkSync(fixture.scapeDir, link);

      expect(() => run({ managersRoot: join(link, 'new-managers') })).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));

      expect(readdirSync(fixture.scapeDir).sort()).toEqual(scapeFilesBefore);
      nothingWasImported();
    });

    it('refuses a manager folder that already exists as a symlink and leaves its target untouched', () => {
      writeArguses(fixture, [anArgus({ name: 'Alpha' })]);
      const elsewhere = join(fixture.workDir, 'elsewhere');
      mkdirSync(elsewhere);
      mkdirSync(managersRoot);
      symlinkSync(elsewhere, join(managersRoot, 'Alpha'));

      expect(() => run()).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));

      expect(readdirSync(elsewhere)).toEqual([]);
      nothingWasImported();
    });

    it('accepts a manager folder that already exists as a real folder and keeps what it holds', () => {
      writeArguses(fixture, [anArgus({ name: 'Alpha' })]);
      mkdirSync(join(managersRoot, 'Alpha'), { recursive: true });
      writeFileSync(join(managersRoot, 'Alpha', 'keep.txt'), 'mine');

      run();

      expect(readdirSync(join(managersRoot, 'Alpha'))).toEqual(['keep.txt']);
      expect(countOf('managers')).toBe(1);
    });
  });

  describe('a failing folder step', () => {
    it('leaves nothing behind when the managers root is a file', () => {
      writeArguses(fixture, [anArgus()]);
      writeFileSync(managersRoot, 'i am a file');

      expect(() => run()).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));

      nothingWasImported();
    });

    it('removes the folders this run created when the second manager cannot get its folder', () => {
      writeArguses(fixture, [anArgus({ name: 'Alpha' }), aSecondArgus({ name: 'Beta' })]);
      mkdirSync(managersRoot);
      writeFileSync(join(managersRoot, 'Beta'), 'a file where the folder should go');

      expect(() => run()).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));

      expect(readdirSync(managersRoot)).toEqual(['Beta']);
      nothingWasImported();
    });

    it('removes a managers root this run created when a manager folder then fails', () => {
      writeArguses(fixture, [anArgus({ name: 'Alpha' })]);
      const missingParent = join(fixture.workDir, 'deep', 'er', 'managers');
      mkdirSync(join(fixture.workDir, 'deep'));
      writeFileSync(join(fixture.workDir, 'deep', 'er'), 'blocking file');

      expect(() => run({ managersRoot: missingParent })).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));

      expect(readdirSync(join(fixture.workDir, 'deep'))).toEqual(['er']);
    });
  });

  describe('which managers get a folder', () => {
    it('creates no folder for a manager left alone because its session id is taken by a non-manager', () => {
      writeArguses(fixture, [anArgus({ name: 'Alpha' })]);
      run();
      const db = new DatabaseSync(join(home, 'openfleet.db'));
      db.prepare('DELETE FROM managers WHERE session_id = ?').run(LEAD_ARGUS_ID);
      db.close();
      rmSync(join(managersRoot, 'Alpha'), { recursive: true });
      writeArguses(fixture, [anArgus({ name: 'Alpha' }), aSecondArgus({ name: 'Beta' })]);

      const report = run();

      expect(report.counts.managers).toMatchObject({ written: 1, conflict: 1 });
      expect(readdirSync(managersRoot)).toEqual(['Beta']);
    });
  });
});
