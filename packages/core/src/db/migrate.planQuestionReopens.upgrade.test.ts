import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const reopensDownMigration = new URL('./migrations-down/060_plan_question_reopens.down.sql', import.meta.url);

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

const BEFORE_REOPENS = '059_session_read_directories.sql';
const WITH_REOPENS = '060_plan_question_reopens.sql';

const columnNamesOf = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(({ name }) => name);

const insertManagerAndBatch = (db: DatabaseSync) => {
  db.exec("INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at) VALUES ('m1', 'Lead', '/tmp', 'fake', 'idle', 't', 'hook', 'mcp', 't')");
  db.exec("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES ('m1', 3600, 2, 'Lead', 't')");
  db.exec("INSERT INTO plan_question_batches (id, manager_id, ticket, plan_note_id, plan_note_rev, created_at) VALUES ('b1', 'm1', 'CCM-1', 'n1', 1, 't')");
};

const insertQuestion = (db: DatabaseSync, questionId: string) =>
  db.exec(`INSERT INTO plan_questions (batch_id, question_id, text, declared_class, computed_classes_json, effective_classes_json, route, status) VALUES ('b1', '${questionId}', 'which name?', 'technical', '[]', '[]', 'arbiter', 'decided')`);

const reopensOf = (db: DatabaseSync, questionId: string) =>
  db.prepare('SELECT reopens_batch_id, reopens_question_id FROM plan_questions WHERE question_id = ?').get(questionId);

describe('migration 060, the reopen link of a plan question', () => {
  it('leaves every question that existed before the migration with no reopen link', () => {
    const db = databaseUpTo(BEFORE_REOPENS);
    insertManagerAndBatch(db);
    insertQuestion(db, 'q1');

    applyMigrations(db, migrationsUpTo(WITH_REOPENS));

    expect(reopensOf(db, 'q1')).toEqual({ reopens_batch_id: null, reopens_question_id: null });
  });

  it('stores the batch and the question a reopening question points at', () => {
    const db = databaseUpTo(WITH_REOPENS);
    insertManagerAndBatch(db);
    insertQuestion(db, 'q1');

    db.exec("UPDATE plan_questions SET reopens_batch_id = 'b1', reopens_question_id = 'q1' WHERE question_id = 'q1'");

    expect(reopensOf(db, 'q1')).toEqual({ reopens_batch_id: 'b1', reopens_question_id: 'q1' });
  });

  it('is undone by its down migration, which drops both columns and keeps the questions', () => {
    const databaseBefore = databaseUpTo(BEFORE_REOPENS);
    const databaseAfter = databaseUpTo(WITH_REOPENS);
    insertManagerAndBatch(databaseAfter);
    insertQuestion(databaseAfter, 'q1');

    databaseAfter.exec(readFileSync(reopensDownMigration, 'utf8'));

    expect(columnNamesOf(databaseAfter, 'plan_questions')).toEqual(columnNamesOf(databaseBefore, 'plan_questions'));
    expect(databaseAfter.prepare('SELECT count(*) AS count FROM plan_questions').get()).toEqual({ count: 1 });
  });
});

describe('migration 061, the index on the reopen link of a plan question', () => {
  const WITH_REOPENS_INDEX = '061_plan_question_reopens_index.sql';
  const reopensIndexDownMigration = new URL('./migrations-down/061_plan_question_reopens_index.down.sql', import.meta.url);
  const IS_REOPENED_QUERY = 'SELECT 1 AS found FROM plan_questions WHERE reopens_batch_id = ? AND reopens_question_id = ? LIMIT 1';

  const queryPlanOf = (db: DatabaseSync): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${IS_REOPENED_QUERY}`).all('b1', 'q1') as { detail: string }[]).map(({ detail }) => detail).join(' | ');

  it('turns the full scan of the is-reopened lookup into an index search', () => {
    const planWithoutIndex = queryPlanOf(databaseUpTo(WITH_REOPENS));
    const planWithIndex = queryPlanOf(databaseUpTo(WITH_REOPENS_INDEX));

    expect(planWithoutIndex).toMatch(/SCAN plan_questions/);
    expect(planWithIndex).toMatch(/SEARCH plan_questions USING (COVERING )?INDEX plan_questions_by_reopened_question/);
  });

  it('is undone by its down migration, which drops the index and keeps the questions', () => {
    const db = databaseUpTo(WITH_REOPENS_INDEX);
    insertManagerAndBatch(db);
    insertQuestion(db, 'q1');

    db.exec(readFileSync(reopensIndexDownMigration, 'utf8'));

    expect(queryPlanOf(db)).toMatch(/SCAN plan_questions/);
    expect(db.prepare('SELECT count(*) AS count FROM plan_questions').get()).toEqual({ count: 1 });
  });
});
