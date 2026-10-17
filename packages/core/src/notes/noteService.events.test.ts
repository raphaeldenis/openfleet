import type { DatabaseSync } from 'node:sqlite';
import type { NoteChangeEvent } from '@openfleet/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { inTransaction } from '../db/transaction.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { expandMentions } from './mentionExpander.js';
import { NoteRepository } from './noteRepository.js';
import { NoteService, StaleRevisionError } from './noteService.js';

const AUTHOR = 'tester';
const PROJECT_ID = 'p1';

interface PublishedChange { event: NoteChangeEvent; wasInsideTransaction: boolean }

let db: DatabaseSync;
let notes: NoteService;
let published: PublishedChange[];

beforeEach(() => {
  db = openDatabase(':memory:');
  new ProjectRepository(db).insert({ id: PROJECT_ID, name: 'P1', docsFolderPath: null, createdAt: 't0' });
  published = [];
  let sequence = 0;
  notes = new NoteService({
    repo: new NoteRepository(db), db, expandMentions, clock: () => `t${sequence}`, newId: () => `id-${sequence++}`,
    publishChange: (event) => published.push({ event, wasInsideTransaction: db.isTransaction }),
  });
});

const events = () => published.map(({ event }) => event);
const aNote = () => notes.create({ projectId: PROJECT_ID, title: 'Secret title', bodyMd: '## A\none', author: AUTHOR });

describe('NoteService change events', () => {
  it('publishes note.created with the id, the project and rev 1 once the insert has committed', () => {
    const note = aNote();

    expect(events()).toEqual([{ type: 'note.created', noteId: note.id, projectId: PROJECT_ID, rev: 1 }]);
    expect(published[0]!.wasInsideTransaction).toBe(false);
  });

  it('publishes one note.updated per revisioned write, each with the rev it produced and the source it was given', () => {
    const note = aNote();
    published = [];

    const afterUpdate = notes.update(note.id, { bodyMd: 'x', expectedRev: 1, author: AUTHOR, source: 'rest' });
    const afterRename = notes.rename(note.id, { title: 'T2', expectedRev: afterUpdate.rev, author: AUTHOR, source: 'rest' });
    const afterBoth = notes.updateBodyAndTitle(note.id, { title: 'T3', bodyMd: 'y', expectedRev: afterRename.rev, author: AUTHOR, source: 'restore' });

    expect(events()).toEqual([afterUpdate, afterRename, afterBoth].map(({ rev }, index) => ({ type: 'note.updated', noteId: note.id, projectId: PROJECT_ID, rev, source: index === 2 ? 'restore' : 'rest' })));
    expect(published.every(({ wasInsideTransaction }) => !wasInsideTransaction)).toBe(true);
  });

  it('publishes exactly one event for an append, even when the first attempts lose the compare-and-set', () => {
    const note = aNote();
    published = [];

    const appended = notes.append(note.id, { content: 'tail', author: AUTHOR });

    expect(events()).toEqual([{ type: 'note.updated', noteId: note.id, projectId: PROJECT_ID, rev: appended.rev, source: 'mcp' }]);
  });

  it('publishes nothing for a stale revision', () => {
    const note = aNote();
    notes.update(note.id, { bodyMd: 'x', expectedRev: 1, author: AUTHOR });
    published = [];

    expect(() => notes.update(note.id, { bodyMd: 'late', expectedRev: 1, author: AUTHOR })).toThrow(StaleRevisionError);

    expect(events()).toEqual([]);
  });

  it('publishes nothing when the enclosing transaction rolls back after the write', () => {
    const note = aNote();
    published = [];

    expect(() => notes.runAtomically(() => {
      notes.update(note.id, { bodyMd: 'x', expectedRev: 1, author: AUTHOR });
      throw new Error('the file rename failed');
    })).toThrow('the file rename failed');

    expect(events()).toEqual([]);
  });

  it('publishes a write made inside runAtomically only after the outer commit', () => {
    const note = aNote();
    published = [];

    notes.runAtomically(() => {
      notes.update(note.id, { bodyMd: 'x', expectedRev: 1, author: AUTHOR });
      expect(events()).toEqual([]);
    });

    expect(events()).toHaveLength(1);
    expect(published[0]!.wasInsideTransaction).toBe(false);
  });

  it('keeps the events of the writes that survive when only a nested savepoint rolls back', () => {
    const note = aNote();
    published = [];

    notes.runAtomically(() => {
      const afterFirst = notes.update(note.id, { bodyMd: 'first', expectedRev: 1, author: AUTHOR });
      try {
        notes.runAtomically(() => {
          notes.update(note.id, { bodyMd: 'second', expectedRev: afterFirst.rev, author: AUTHOR });
          throw new Error('inner failure');
        });
      } catch { /* the outer transaction carries on */ }
    });

    expect(events().map((event) => (event as { rev?: number }).rev)).toEqual([2]);
  });

  it('publishes the write of a caller that runs inside a transaction of its own only after that transaction commits', () => {
    inTransaction(db, 'caller_work', () => {
      aNote();
      expect(events()).toEqual([]);
    });

    expect(events()).toHaveLength(1);
    expect(published[0]!.wasInsideTransaction).toBe(false);
  });

  it('publishes nothing when the caller transaction around the write rolls back', () => {
    expect(() => inTransaction(db, 'caller_work', () => {
      aNote();
      throw new Error('caller failed');
    })).toThrow('caller failed');

    expect(events()).toEqual([]);
  });

  it('publishes note.deleted with the id and the project once the delete has committed, and nothing for an unknown id', () => {
    const note = aNote();
    published = [];

    notes.delete('no-such-note');
    notes.delete(note.id);

    expect(events()).toEqual([{ type: 'note.deleted', noteId: note.id, projectId: PROJECT_ID }]);
    expect(published[0]!.wasInsideTransaction).toBe(false);
  });

  it('never puts the title or the body in an event', () => {
    const note = aNote();
    notes.update(note.id, { bodyMd: 'a body nobody should read on the wire', expectedRev: 1, author: AUTHOR });
    notes.delete(note.id);

    const wire = JSON.stringify(events());

    expect(wire).not.toContain('Secret title');
    expect(wire).not.toContain('a body nobody');
  });

  it('keeps the write when the listener throws, and reports no failure to the writer', () => {
    const throwing = new NoteService({
      repo: new NoteRepository(db), db, expandMentions, clock: () => 't', newId: () => 'throwing-id', publishChange: () => { throw new Error('listener failed'); },
    });

    const note = throwing.create({ projectId: PROJECT_ID, title: 'x', bodyMd: '', author: AUTHOR });

    expect(new NoteRepository(db).get(note.id)).toBeDefined();
  });
});
