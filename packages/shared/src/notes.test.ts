import { describe, expect, it } from 'vitest';
import { MentionRefSchema, NOTE_FOLDERS, NoteFolderSchema, type Note, type NoteVersion } from './notes.js';

describe('NoteFolderSchema', () => {
  it('accepts every docs-folder name', () => {
    expect(NOTE_FOLDERS).toEqual(['specs', 'plans', 'handoffs', 'reports']);
    NOTE_FOLDERS.forEach((folder) => expect(NoteFolderSchema.parse(folder)).toBe(folder));
  });

  it('rejects a folder outside the docs layout', () => {
    expect(() => NoteFolderSchema.parse('archive')).toThrow();
  });
});

describe('MentionRefSchema', () => {
  it('accepts each mention kind with an id the mention regex can match', () => {
    const kinds = ['note', 'repo', 'table', 'playbook'] as const;
    kinds.forEach((kind) => expect(MentionRefSchema.parse({ kind, id: 'a_B-9' })).toEqual({ kind, id: 'a_B-9' }));
  });

  it('rejects an unknown kind', () => {
    expect(() => MentionRefSchema.parse({ kind: 'session', id: 'x' })).toThrow();
  });

  it('rejects an empty id', () => {
    expect(() => MentionRefSchema.parse({ kind: 'note', id: '' })).toThrow();
  });

  it('rejects an id containing characters the mention regex would not capture', () => {
    expect(() => MentionRefSchema.parse({ kind: 'note', id: 'has space' })).toThrow();
  });
});

describe('Note and NoteVersion', () => {
  it('a free-standing note and a file-backed note both satisfy Note and survive a JSON round-trip', () => {
    const freeStanding: Note = { id: 'n1', projectId: 'p1', title: 'T', bodyMd: '# T', folder: null, filePath: null, sourceHash: null, rev: 1, shared: false, createdAt: 't0', updatedAt: 't0' };
    const fileBacked: Note = { ...freeStanding, id: 'n2', folder: 'specs', filePath: '/docs/specs/2026-01-01-t.md', sourceHash: 'deadbeef', shared: true };
    expect(JSON.parse(JSON.stringify([freeStanding, fileBacked]))).toEqual([freeStanding, fileBacked]);
  });

  it('a version with no change summary satisfies NoteVersion', () => {
    const version: NoteVersion = { id: 'v1', noteId: 'n1', rev: 1, bodyMd: '# T', author: 's1', changeSummary: null, createdAt: 't0' };
    expect(JSON.parse(JSON.stringify(version))).toEqual(version);
  });
});
