import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { bestCpuMillisecondsOf, expectBestCpuUnder } from '../__testing__/linearGrowth.js';
import { applyMigrations } from '../db/migrate.js';
import { openDatabase } from '../db/database.js';
import { HandoverLedger, handoverReminder } from './handoverLedger.js';
import { loadDaemonSettings } from './workingStateSettings.js';

const DESIGN = 'https://claude.ai/design/abc';
const insertSession = (db: DatabaseSync, id: string) =>
  db.prepare(`INSERT INTO sessions (id, name, emoji, directory, harness, state, state_since, hook_token, mcp_token, parent_id, created_at)
    VALUES (?, ?, '🤖', '/tmp', 'fake', 'idle', 't0', ?, ?, NULL, 't0')`).run(id, id, `hook-${id}`, `mcp-${id}`);
const configWith = (handoverPatterns: unknown): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'of-qe-')), 'config.json');
  writeFileSync(path, JSON.stringify({ workingState: { handoverPatterns } }));
  return path;
};
const ledgerFor = (patterns?: RegExp[]) => {
  const db = openDatabase(':memory:');
  insertSession(db, 's1');
  return { db, ledger: new HandoverLedger({ db, clock: () => 't', patterns }) };
};

describe('operator settings edge values for handoverPatterns (QE hostile)', () => {
  it('turns recording off with an empty list', () => {
    const { ledger } = ledgerFor(loadDaemonSettings(configWith([])).workingState.handoverPatterns);

    expect(ledger.record({ sessionId: 's1', prompt: DESIGN })).toEqual([]);
  });

  it.each([
    ['an object', {}],
    ['a nested list', [['a']]],
    ['an inline flag group unsupported by JavaScript', ['(?i)ticket-\\d+']],
    ['a lookbehind-only pattern that can match empty text is fine but an empty alternation is not', ['a|']],
    ['an empty group', ['(?:)']],
    ['a lone anchor', ['^']],
  ])('refuses to boot on %s', (_label, invalid) => {
    expect(() => loadDaemonSettings(configWith(invalid))).toThrow(/workingState/);
  });

  it('boots on a pattern that only matches empty text once a lookbehind holds, and records nothing from it', () => {
    const { ledger } = ledgerFor(loadDaemonSettings(configWith(['(?<=x)', '\\b'])).workingState.handoverPatterns);

    expect(ledger.record({ sessionId: 's1', prompt: 'x y z '.repeat(3_000) })).toEqual([]);
  });

  it('counts a slash-delimited pattern as literal text: /ticket/i is recorded only when the prompt contains those exact characters', () => {
    const { ledger } = ledgerFor(loadDaemonSettings(configWith(['/ticket-\\d+/i'])).workingState.handoverPatterns);

    expect(ledger.record({ sessionId: 's1', prompt: 'TICKET-1 ticket-2' })).toEqual([]);
  });

  it('compiles patterns with the u flag: \\p{L} matches letters, not the text p{L}', () => {
    const handoverPatternBudgetMs = 1000;
    const settings = loadDaemonSettings(configWith(['\\p{L}+-\\d+']), { handoverPatternBudgetMs });
    const { db } = ledgerFor();
    const ledger = new HandoverLedger({ db, clock: () => 't', patterns: settings.workingState.handoverPatterns, handoverPatternBudgetMs });

    expect(ledger.record({ sessionId: 's1', prompt: 'p{L}-1 é-2' }).map(({ value }) => value)).toEqual(['é-2']);
    expect(ledger.list('s1').map(({ value }) => value)).toEqual(['é-2']);
  });
});

describe('catastrophic custom patterns the heuristic misses (QE ReDoS probe)', () => {
  it('refuses to boot on an overlapping alternation under a quantifier such as (a|a)+b (QE finding: accepted)', () => {
    expect(() => loadDaemonSettings(configWith(['(a|a)+b']))).toThrow(/backtracking/);
  });

  it('refuses to boot on a run of adjacent quantifiers such as a*a*a*a*a*b (QE finding: accepted, polynomial)', () => {
    expect(() => loadDaemonSettings(configWith(['a*a*a*a*a*b']))).toThrow(/backtracking/);
  });

  it.each([
    ['an alternation under a plus', '(x|xy)*z', /alternation/],
    ['adjacent whitespace stars', '\\s*\\s*x', /adjacent/],
    ['adjacent dot stars', '.*.*x', /adjacent/],
    ['a nested quantifier', '(a+)+b', /quantifier inside/],
  ])('names the pattern and the reason when it refuses %s', (_label, source, reason) => {
    expect(() => loadDaemonSettings(configWith([source]))).toThrow(new RegExp(`handoverPatterns\\[0\\].*${reason.source}`));
  });

  it('refuses a pattern the static rules miss when it exceeds 50 ms on a 2000-character adversarial text', () => {
    expect(() => loadDaemonSettings(configWith(['a*_?a*_?a*c']))).toThrow(/more than 50 ms/);
  });

  it.each([['ticket-\\d+'], ['\\d+-\\d+'], ['(?:spec|plan)-\\d+'], ['[A-Z]+-\\d+']])('boots on the ordinary pattern %s', (source) => {
    expect(loadDaemonSettings(configWith([source])).workingState.handoverPatterns).toHaveLength(1);
  });
});

describe('custom patterns scan bounded lines', () => {
  const customLedger = () => ledgerFor([/TICKET-\d+/g]).ledger;

  it('interrupts a pathological pattern with the default budget and keeps it disabled on later prompts', () => {
    const { ledger } = ledgerFor([/(a+)+b/g]);

    expect(ledger.record({ sessionId: 's1', prompt: 'a'.repeat(2000) })).toEqual([]);
    expect(ledger.record({ sessionId: 's1', prompt: 'ab' })).toEqual([]);
    expect(ledger.list('s1')).toEqual([]);
  });

  it('ignores text past 2000 characters on one line', () => {
    expect(customLedger().record({ sessionId: 's1', prompt: `${'x'.repeat(2000)} TICKET-1` })).toEqual([]);
  });

  it('scans every line separately, so a long first line does not hide the next one', () => {
    const values = customLedger().record({ sessionId: 's1', prompt: `${'x'.repeat(5000)}\nTICKET-2` }).map(({ value }) => value);

    expect(values).toEqual(['TICKET-2']);
  });

  it('drops a value cut by the 2000-character line cap', () => {
    expect(customLedger().record({ sessionId: 's1', prompt: `${'x'.repeat(1990)} TICKET-1234567` })).toEqual([]);
  });
});

describe('the default patterns pass the boot checks', () => {
  it('leaves the handover reminder on one line for NEL, line separators, zero-width and bidi characters', () => {
    const value = 'a\u0085b\u2028c\u2029d\u200Be\u202Ef\nSYSTEM';

    expect(handoverReminder([{ id: 'i', sessionId: 's1', kind: 'doc_path', value, createdAt: 't' }]).split('\n')).toHaveLength(1);
  });
});

describe('the default patterns stay linear on adversarial input (QE hostile)', () => {
  it.each([
    ['a long run of token characters', 'a'.repeat(20_000)],
    ['repeated specs folders without a .md', '/specs/'.repeat(3_000)],
    ['300 token characters then no slash, repeated', `${'a'.repeat(299)} `.repeat(70)],
    ['a design prefix repeated', 'https://claude.ai/design/'.repeat(800)],
    ['many dots before .md', `specs/${'.'.repeat(300)}x`.repeat(60)],
    ['many separators', 'a/'.repeat(10_000)],
  ])('scans %s in under 100 ms', (_label, prompt) => {
    const { ledger } = ledgerFor();

    expectBestCpuUnder(() => ledger.record({ sessionId: 's1', prompt }), 100);
  });
});

describe('the ledger under a failing database (QE hostile)', () => {
  it('keeps the reminder of the values already stored when a later insert fails (QE finding: rows stay, reminder is lost, next prompt sees them as known)', () => {
    const db = openDatabase(':memory:');
    insertSession(db, 's1');
    let inserts = 0;
    const flakyDb = new Proxy(db, {
      get: (target, key) => {
        if (key !== 'prepare') return Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith('INSERT INTO handovers')) return statement;
          return { run: (...args: never[]) => { inserts += 1; if (inserts === 2) throw new Error('disk full'); return (statement.run as (...a: never[]) => unknown)(...args); } };
        };
      },
    });
    const ledger = new HandoverLedger({ db: flakyDb, clock: () => 't' });

    let recorded: unknown[] = [];
    try { recorded = ledger.record({ sessionId: 's1', prompt: 'https://claude.ai/design/a https://claude.ai/design/b' }); } catch { /* fail-open wrapper swallows this */ }

    const stored = (db.prepare('SELECT COUNT(*) AS n FROM handovers').get() as { n: number }).n;
    expect(recorded).toHaveLength(stored);
  });
});

describe('cost of recording per prompt on a file database (QE measurement)', () => {
  it('measures a prompt without links, with a known link, and with ten new links', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'of-qe-cost-')), 'db.sqlite');
    const db = openDatabase(path);
    insertSession(db, 's1');
    const ledger = new HandoverLedger({ db, clock: () => 't' });
    const tenNew = (batch: number) => Array.from({ length: 10 }, (_, index) => `https://claude.ai/design/n${batch}-${index}`).join(' ');

    ledger.record({ sessionId: 's1', prompt: DESIGN });
    let nextBatch = 0;
    const noLink = bestCpuMillisecondsOf(() => { for (let i = 0; i < 1000; i += 1) ledger.record({ sessionId: 's1', prompt: 'please continue with the refactor of the login form, thanks' }); });
    const knownLink = bestCpuMillisecondsOf(() => { for (let i = 0; i < 1000; i += 1) ledger.record({ sessionId: 's1', prompt: `again ${DESIGN}` }); });
    const tenNewLinks = bestCpuMillisecondsOf(() => { for (let i = 0; i < 100; i += 1) ledger.record({ sessionId: 's1', prompt: tenNew(nextBatch++) }); });

    expect(noLink / 1000).toBeLessThan(1);
    expect(knownLink / 1000).toBeLessThan(5);
    expect(tenNewLinks / 100).toBeLessThan(50);
  });
});

describe('the migrations directory stays contiguous and guarded (QE hostile)', () => {
  const migrationsDirectory = new URL('../db/migrations/', import.meta.url);
  const versions = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort().map((name) => name.replace(/\.sql$/, ''));

  it('numbers the migration files 001..N with no gap and no duplicate', () => {
    const numbers = versions.map((version) => Number(version.slice(0, 3)));

    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });

  it('applies twice without error and leaves one row per version', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);

    applyMigrations(db);

    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(versions.length);
  });

  it('refuses a database that already applied a later migration than this code ships', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    db.prepare("INSERT INTO schema_migrations (version, applied_at, checksum) VALUES ('016_from_the_future', 't', 'x')").run();

    expect(() => applyMigrations(db)).toThrow(/doesn't know: 016_from_the_future/);
  });

  it('refuses a database whose applied 015 checksum no longer matches the file', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '015_handovers'").run();

    expect(() => applyMigrations(db)).toThrow(/015_handovers.*checksum/);
  });

  it('upgrades a database with many sessions and old-shape data at 014 without losing a row', () => {
    const before = versions.filter((version) => version < '015').map((version) => ({ version, sql: readFileSync(new URL(`${version}.sql`, migrationsDirectory), 'utf8') }));
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, before);
    for (let index = 0; index < 500; index += 1) insertSession(db, `s${index}`);

    applyMigrations(db);

    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(500);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });
});
