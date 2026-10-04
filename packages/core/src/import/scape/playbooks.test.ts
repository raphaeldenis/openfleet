import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { importScape } from './importScape.js';
import { buildScapeFixture, editScapeDatastore, editScapeNotes, scapeBacklogTable, OPENFLEET_PROJECT_ID, CCM_PROJECT_ID } from './scapeFixture.testkit.js';
import { anArgus, LEAD_ARGUS_ID, writeArguses } from './scapeArguses.testkit.js';

function fixtureWithPlaybooks() {
  const fixture = buildScapeFixture();
  editScapeNotes(fixture, (db) => {
    db.exec(`ALTER TABLE project_items ADD COLUMN displayName TEXT;
      CREATE TABLE playbooks (id TEXT PRIMARY KEY, lexicalContent TEXT, secrets TEXT, createdAt REAL, updatedAt REAL);
      CREATE TABLE trigger_secret_catalog (name TEXT, currentEntryID TEXT);
      INSERT INTO trigger_secret_catalog VALUES ('GLOBAL_SECRET', 'NEVER_EXPORT_SECRET_ENTRY');`);
    const addPlaybook = (input: { id: string; projectId: string; name: string }) => {
      db.prepare('INSERT INTO project_items (id, projectID, kind, displayName) VALUES (?, ?, ?, ?)').run(input.id, input.projectId, 'playbook', input.name);
      const lexical = { root: { type: 'root', children: [
        { type: 'paragraph', children: [{ type: 'text', text: 'Description <script>alert(1)</script>' }] },
        { type: 'playbook-step', kind: 'shell', label: 'check', args: { command: 'echo {{secret:TEST_SECRET}}\n```\n<script>bad</script>' }, outputCache: { stdout: 'NEVER_EXPORT_OUTPUT', stderr: 'NEVER_EXPORT_ERROR' } },
        { type: 'playbook-inputs', inputs: [{ name: 'branch', default: 'main' }], secrets: [{ name: 'TEST_SECRET', value: 'NEVER_EXPORT_SECRET_VALUE' }] },
      ] } };
      db.prepare('INSERT INTO playbooks VALUES (?, ?, ?, ?, ?)').run(input.id, JSON.stringify(lexical), '["TEST_SECRET"]', 811089628, 811089628);
    };
    addPlaybook({ id: 'pb-verify', projectId: OPENFLEET_PROJECT_ID, name: 'verify' });
    addPlaybook({ id: 'pb-dev', projectId: OPENFLEET_PROJECT_ID, name: 'dev-servers' });
    addPlaybook({ id: 'pb-mr', projectId: CCM_PROJECT_ID, name: 'open-mr' });
  });
  const scratchRoot = join(fixture.workDir, 'snapshots');
  mkdirSync(scratchRoot);
  const options = { scapeDir: fixture.scapeDir, home: join(fixture.workDir, 'home'), superpowersRoot: join(fixture.workDir, 'docs'), scratchRoot };
  return { fixture, options };
}

function withTarget<T>(home: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(home, 'openfleet.db'));
  try { return read(db); } finally { db.close(); }
}

describe('playbook migration', () => {
  it('archives each project in one inert note and reports individual playbooks', () => {
    const { options } = fixtureWithPlaybooks();
    const report = importScape(options);
    const notes = withTarget(options.home, (db) => db.prepare("SELECT project_id, body_md FROM notes WHERE title = 'Playbooks (ex-Scape)' ORDER BY project_id").all()) as { project_id: string; body_md: string }[];
    expect(notes).toHaveLength(2);
    const body = notes.find((note) => note.project_id === OPENFLEET_PROJECT_ID)!.body_md;
    expect(body).toContain('verify');
    expect(body).toContain('dev-servers');
    expect(body).toContain('[non converti: playbook]');
    expect(body).toContain('scripts/verify.sh');
    expect(body).toContain('~/Documents/scape-team/openfleet/dev-servers.sh');
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('echo {{secret:TEST_SECRET}}');
    expect(body).toContain('to set as environment variables');
    expect(body).toContain('GLOBAL_SECRET');
    expect(body).not.toContain('<script>');
    expect(notes.map((note) => note.body_md).join('\n')).not.toContain('NEVER_EXPORT');
    expect(report.counts).toHaveProperty('playbooks', expect.objectContaining({ expected: 3, written: 3, notConverted: 3 }));
    expect(readFileSync(report.reportPath!, 'utf8')).toContain('| playbooks | 3 | 3 | 0 | 0 | 0 | 3 |');
    expect(readdirSync(options.scratchRoot)).toEqual([]);
  });

  it('writes zero on the second run and preserves note versions', () => {
    const { options, fixture } = fixtureWithPlaybooks();
    writeArguses(fixture, [anArgus()]);
    const first = importScape(options);
    expect(first.counts.managers).toMatchObject({ expected: 1, written: 1 });
    expect(existsSync(join(options.home, 'managers', 'Alpha'))).toBe(true);
    const managerIds = withTarget(options.home, (db) => db.prepare('SELECT session_id FROM managers').all());
    expect(managerIds).toEqual([{ session_id: LEAD_ARGUS_ID }]);
    const firstNotes = withTarget(options.home, (db) => db.prepare('SELECT * FROM notes ORDER BY id').all());
    const firstVersions = withTarget(options.home, (db) => db.prepare('SELECT * FROM note_versions ORDER BY id').all());
    const second = importScape(options);
    expect(Object.values(second.counts).every((counts) => counts.written === 0 && counts.updated === 0)).toBe(true);
    expect(second.counts).toHaveProperty('playbooks', expect.objectContaining({ alreadyPresent: 3 }));
    expect(second.counts.managers).toMatchObject({ alreadyPresent: 1, written: 0 });
    expect(withTarget(options.home, (db) => db.prepare('SELECT session_id FROM managers').all())).toEqual(managerIds);
    expect(withTarget(options.home, (db) => db.prepare('SELECT * FROM notes ORDER BY id').all())).toEqual(firstNotes);
    expect(withTarget(options.home, (db) => db.prepare('SELECT * FROM note_versions ORDER BY id').all())).toEqual(firstVersions);
    expect(readdirSync(options.scratchRoot)).toEqual([]);
  });

  it('leaves source files unchanged and dry runs leave no target or temporary snapshots', () => {
    const { options } = fixtureWithPlaybooks();
    const sourcePath = join(options.scapeDir, 'notes.sqlite');
    const hash = () => createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
    const sourceHash = hash();
    const sourceFiles = readdirSync(options.scapeDir);
    const report = importScape({ ...options, dryRun: true, projectName: 'OpenFleet' });
    expect(report.counts).toHaveProperty('playbooks', expect.objectContaining({ expected: 2, written: 2 }));
    expect(existsSync(options.home)).toBe(false);
    expect(hash()).toBe(sourceHash);
    expect(readdirSync(options.scapeDir)).toEqual(sourceFiles);
    expect(readdirSync(options.scratchRoot)).toEqual([]);
  });

  it('rolls back the archives written earlier in the run when a later family fails', () => {
    const { options, fixture } = fixtureWithPlaybooks();
    importScape(options);
    const archiveNotes = "title = 'Playbooks (ex-Scape)'";
    withTarget(options.home, (db) => {
      db.exec(`DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE ${archiveNotes})`);
      db.exec(`DELETE FROM notes WHERE ${archiveNotes}`);
      db.exec(`CREATE TRIGGER refuse_rows BEFORE INSERT ON ds_rows BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    });
    editScapeDatastore(fixture, (db) => db.prepare(`INSERT INTO ${scapeBacklogTable} (row_id, row_created_at, row_updated_at) VALUES ('R-new', 1790246300, 1790246300)`).run());

    expect(() => importScape(options)).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));

    const archiveCount = withTarget(options.home, (db) => db.prepare(`SELECT count(*) AS n FROM notes WHERE ${archiveNotes}`).get());
    expect(archiveCount).toEqual({ n: 0 });
  });

  it('reports every playbook as a conflict when its archive is edited in OpenFleet', () => {
    const { options, fixture } = fixtureWithPlaybooks();
    importScape(options);
    withTarget(options.home, (db) => db.prepare("UPDATE notes SET body_md = 'human edit', rev = 2 WHERE title = 'Playbooks (ex-Scape)' AND project_id = ?").run(OPENFLEET_PROJECT_ID));
    editScapeNotes(fixture, (db) => db.prepare("UPDATE playbooks SET updatedAt = updatedAt + 1 WHERE id = 'pb-verify'").run());
    const report = importScape(options);
    expect(report.counts).toHaveProperty('playbooks', expect.objectContaining({ conflict: 2, alreadyPresent: 1 }));
    const body = withTarget(options.home, (db) => db.prepare("SELECT body_md FROM notes WHERE title = 'Playbooks (ex-Scape)' AND project_id = ?").get(OPENFLEET_PROJECT_ID));
    expect(body).toEqual(expect.objectContaining({ body_md: 'human edit' }));
  });
});
