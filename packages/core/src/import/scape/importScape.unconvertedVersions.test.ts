import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { importScape } from './importScape.js';
import { buildScapeFixture, editScapeNotes, LEXICAL_NOTE_ID } from './scapeFixture.testkit.js';

const APPLE_SECONDS = 811_089_628;

const lexicalDocumentOf = (...blocks: object[]) => JSON.stringify({ root: { type: 'root', children: blocks } });
const textBlock = (value: string) => ({ type: 'paragraph', children: [{ type: 'text', text: value, format: 0 }] });

function setup() {
  const fixture = buildScapeFixture();
  const home = join(fixture.workDir, 'target');
  const run = () => importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'specs') });
  const giveMissionNoteUnknownNodes = (input: { title?: string } = {}) => editScapeNotes(fixture, (db) => {
    db.prepare('INSERT INTO note_versions (id, noteID, title, content, contentFormat, createdAt, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('ver-unknown-node', LEXICAL_NOTE_ID, 'Mission', lexicalDocumentOf(textBlock('old'), { type: 'sticker' }), 'lexical', APPLE_SECONDS + 6, 'user');
    db.prepare('UPDATE notes SET content = ?, title = ? WHERE id = ?')
      .run(lexicalDocumentOf(textBlock('now'), { type: 'gizmo' }), input.title ?? 'Mission', LEXICAL_NOTE_ID);
  });
  return { fixture, home, run, giveMissionNoteUnknownNodes };
}

it('names each note version holding an unconverted node, with its note title, version number and node types', () => {
  const context = setup();
  context.giveMissionNoteUnknownNodes();
  const report = context.run();
  expect(report.unconvertedNoteVersions).toEqual([
    { noteTitle: 'Mission', rev: 2, nodeTypes: ['sticker'] },
    { noteTitle: 'Mission', rev: 3, nodeTypes: ['gizmo'] },
  ]);
  expect(report.counts.noteVersions.notConverted).toBe(2);
});

it('names no version for notes that convert fully', () => {
  expect(setup().run().unconvertedNoteVersions).toEqual([]);
});

it('writes a report for a note holding nodes without a string type', () => {
  const context = setup();
  editScapeNotes(context.fixture, (db) => {
    db.prepare('UPDATE notes SET content = ? WHERE id = ?').run(lexicalDocumentOf({ type: 5 }, {}), LEXICAL_NOTE_ID);
  });
  const report = context.run();
  expect(report.unconvertedNoteVersions).toContainEqual({ noteTitle: 'Mission', rev: 2, nodeTypes: ['5', '(sans type)'] });
  expect(readFileSync(join(context.home, 'import-report.md'), 'utf8')).toContain('Mission — version 2: 5, (sans type)');
});

it('writes the versions and node types in the report, neutralized', () => {
  const context = setup();
  context.giveMissionNoteUnknownNodes({ title: '**Bold**\n## Injected' });
  context.run();
  const reportText = readFileSync(join(context.home, 'import-report.md'), 'utf8');
  expect(reportText).toContain('\\*\\*Bold\\*\\* \\#\\# Injected — version 2: sticker');
  expect(reportText).toContain('\\*\\*Bold\\*\\* \\#\\# Injected — version 3: gizmo');
  expect(reportText).not.toContain('\n## Injected');
});
