import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const escalationDownMigration = new URL('./migrations-down/056_escalation_ladder.down.sql', import.meta.url);

const migrationsUpTo = (lastFileName: string) =>
  readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith('.sql') && fileName <= lastFileName)
    .sort()
    .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const databaseUpTo = (lastFileName: string): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, migrationsUpTo(lastFileName));
  return db;
};

const BEFORE_ESCALATION = '054_project_shared_repo.sql';
const WITH_ESCALATION = '056_escalation_ladder.sql';

const tableNames = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(({ name }) => name);

const columnNamesOf = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(({ name }) => name);

const databaseWithAManagerAndAProject = (): DatabaseSync => {
  const db = databaseUpTo(BEFORE_ESCALATION);
  db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Fleet', '2026-10-29T10:00:00.000Z')");
  db.exec("INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at) VALUES ('m1', 'Lead', '/tmp', 'fake', 'idle', 't', 'hook', 'mcp', 't')");
  db.exec("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES ('m1', 3600, 2, 'Lead', 't')");
  return applyMigrationsTo(db);
};

const applyMigrationsTo = (db: DatabaseSync): DatabaseSync => {
  applyMigrations(db, migrationsUpTo(WITH_ESCALATION));
  return db;
};

const insertEscalation = (db: DatabaseSync, { id, ticket, status }: { id: string; ticket: string; status: 'pending' | 'answered' }) =>
  db.prepare('INSERT INTO escalations (id, manager_id, ticket, status, body, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'm1', ticket, status, 'Escalation', 't0', status === 'pending' ? null : 't1');

describe('migration 056, the escalation ladder', () => {
  it('keeps an existing project and gives it no escalation setting', () => {
    const db = databaseWithAManagerAndAProject();

    const project = db.prepare("SELECT name, escalation_policy_json FROM projects WHERE id = 'p1'").get() as { name: string; escalation_policy_json: string | null };

    expect(project).toEqual({ name: 'Fleet', escalation_policy_json: null });
  });

  it('creates the four tables of the ladder', () => {
    const db = databaseWithAManagerAndAProject();

    expect(tableNames(db)).toEqual(expect.arrayContaining(['plan_question_batches', 'plan_questions', 'arbiter_decisions', 'escalations']));
  });

  it('accepts a policy that is a JSON object and refuses anything else', () => {
    const db = databaseWithAManagerAndAProject();
    const setPolicy = (policy: string) => db.prepare("UPDATE projects SET escalation_policy_json = ? WHERE id = 'p1'").run(policy);

    expect(() => setPolicy('{"askUserGate":"off"}')).not.toThrow();
    expect(() => setPolicy('not json')).toThrow();
    expect(() => setPolicy('[1]')).toThrow();
  });

  describe('the one open escalation per ticket', () => {
    it('refuses a second pending escalation of the same manager and ticket', () => {
      const db = databaseWithAManagerAndAProject();
      insertEscalation(db, { id: 'e1', ticket: 'KB-01a', status: 'pending' });

      expect(() => insertEscalation(db, { id: 'e2', ticket: 'KB-01a', status: 'pending' })).toThrow(/UNIQUE/);
    });

    it('accepts a pending escalation on another ticket', () => {
      const db = databaseWithAManagerAndAProject();
      insertEscalation(db, { id: 'e1', ticket: 'KB-01a', status: 'pending' });

      expect(() => insertEscalation(db, { id: 'e2', ticket: 'KB-02', status: 'pending' })).not.toThrow();
    });

    it('accepts a new pending escalation once the first one is answered', () => {
      const db = databaseWithAManagerAndAProject();
      insertEscalation(db, { id: 'e1', ticket: 'KB-01a', status: 'answered' });

      expect(() => insertEscalation(db, { id: 'e2', ticket: 'KB-01a', status: 'pending' })).not.toThrow();
    });

    it('refuses an answered escalation without its answer time and a pending one with it', () => {
      const db = databaseWithAManagerAndAProject();
      const insertWithTime = (status: string, resolvedAt: string | null) =>
        db.prepare("INSERT INTO escalations (id, manager_id, ticket, status, body, created_at, resolved_at) VALUES ('e9', 'm1', 'T', ?, 'b', 't0', ?)").run(status, resolvedAt);

      expect(() => insertWithTime('answered', null)).toThrow();
      expect(() => insertWithTime('pending', 't1')).toThrow();
    });
  });

  describe('the questions of a batch', () => {
    const insertBatch = (db: DatabaseSync) =>
      db.prepare("INSERT INTO plan_question_batches (id, manager_id, ticket, plan_note_id, plan_note_rev, created_at) VALUES ('b1', 'm1', 'KB-01a', 'n1', 3, 't0')").run();
    const insertQuestion = (db: DatabaseSync, { questionId = 'q1', route = 'arbiter', status = 'open' }: { questionId?: string; route?: string; status?: string } = {}) =>
      db.prepare(`INSERT INTO plan_questions (batch_id, question_id, text, declared_class, computed_classes_json, effective_classes_json, route, status)
        VALUES ('b1', ?, 'Which retry?', 'technical', '[]', '[]', ?, ?)`).run(questionId, route, status);

    it('keeps a declared class outside the vocabulary as written', () => {
      const db = databaseWithAManagerAndAProject();
      insertBatch(db);

      db.prepare(`INSERT INTO plan_questions (batch_id, question_id, text, declared_class, computed_classes_json, effective_classes_json, route, status)
        VALUES ('b1', 'q1', 'x', 'banana', '[]', '[]', 'human', 'pending_human')`).run();

      const stored = db.prepare("SELECT declared_class FROM plan_questions WHERE question_id = 'q1'").get() as { declared_class: string };
      expect(stored.declared_class).toBe('banana');
    });

    it('refuses a route or a status outside the lists, and the same question id twice in a batch', () => {
      const db = databaseWithAManagerAndAProject();
      insertBatch(db);
      insertQuestion(db);

      expect(() => insertQuestion(db, { questionId: 'q2', route: 'manager' })).toThrow();
      expect(() => insertQuestion(db, { questionId: 'q3', status: 'closed' })).toThrow();
      expect(() => insertQuestion(db)).toThrow(/UNIQUE|PRIMARY/);
    });

    it('records an arbiter decision only for a question of the batch, and drops it with the batch', () => {
      const db = databaseWithAManagerAndAProject();
      insertBatch(db);
      insertQuestion(db);
      const insertDecision = (questionId: string) =>
        db.prepare(`INSERT INTO arbiter_decisions (batch_id, question_id, verdict, decision, rationale, arbiter_session_id, plan_note_rev, created_at)
          VALUES ('b1', ?, 'decided', 'Uses backoff.', 'Idempotent.', 'a1', 3, 't1')`).run(questionId);

      expect(() => insertDecision('q1')).not.toThrow();
      expect(() => insertDecision('unknown-question')).toThrow(/FOREIGN KEY/);

      db.exec("DELETE FROM plan_question_batches WHERE id = 'b1'");
      expect(db.prepare('SELECT count(*) AS count FROM arbiter_decisions').get()).toEqual({ count: 0 });
    });

    it('refuses a raise_to that is not an escalating class', () => {
      const db = databaseWithAManagerAndAProject();
      insertBatch(db);
      insertQuestion(db);

      const raiseTo = (escalatingClass: string) =>
        db.prepare(`INSERT INTO arbiter_decisions (batch_id, question_id, verdict, decision, rationale, raise_to, arbiter_session_id, plan_note_rev, created_at)
          VALUES ('b1', 'q1', 'needs_human', 'd', 'r', ?, 'a1', 3, 't1')`).run(escalatingClass);

      expect(() => raiseTo('security')).not.toThrow();
      expect(() => raiseTo('technical')).toThrow();
    });
  });

  it('is undone by its down migration, which drops the four tables and only the policy column', () => {
    const databaseBefore = databaseUpTo(BEFORE_ESCALATION);
    const databaseAfter = databaseUpTo(WITH_ESCALATION);

    databaseAfter.exec(readFileSync(escalationDownMigration, 'utf8'));

    expect(tableNames(databaseAfter)).toEqual(tableNames(databaseBefore));
    expect(columnNamesOf(databaseAfter, 'projects')).toEqual(columnNamesOf(databaseBefore, 'projects'));
  });
});
