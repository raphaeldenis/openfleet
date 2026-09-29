import type { NoteSummary, NoteVersionSummary, NoteView } from '@openfleet/shared';

export function aNoteSummary(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'note-1',
    title: 'daemon-protocol',
    folder: null,
    rev: 1,
    shared: false,
    fileBacked: false,
    updatedAt: '2026-09-29T08:00:00.000Z',
    ...overrides,
  };
}

export function aNoteView(overrides: Partial<NoteView> = {}): NoteView {
  return {
    ...aNoteSummary(),
    projectId: 'project-1',
    bodyMd: '# Daemon protocol\n\nHow the desktop client talks to the daemon.',
    createdAt: '2026-09-29T08:00:00.000Z',
    docsRelativePath: null,
    ...overrides,
  };
}

export function aNoteVersion(overrides: Partial<NoteVersionSummary> = {}): NoteVersionSummary {
  return {
    id: 'version-1',
    rev: 1,
    author: 'You',
    createdAt: '2026-09-29T08:00:00.000Z',
    ...overrides,
  };
}
