import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { DirectoryOpener } from './directory-opener';
import { NotesViewComponent } from './notes-view.component';
import { aNoteSummary, aNoteVersion, aNoteView } from './notes.fixtures';
import type { NoteSummary, NoteView, Project } from '@openfleet/shared';

const OPENFLEET: Project = { id: 'p1', name: 'OpenFleet', docsFolderPath: '/Users/me/docs' };
const OTHER: Project = { id: 'p2', name: 'Other', docsFolderPath: null };
const EMPTY_PROJECT: Project = { id: 'p3', name: 'Empty', docsFolderPath: null };

const SUMMARIES: Record<string, NoteSummary[]> = {
  p1: [aNoteSummary({ id: 'n1', title: 'daemon-protocol', rev: 3 }), aNoteSummary({ id: 'n2', title: 'voice' })],
  p2: [aNoteSummary({ id: 'n9', title: 'other-note' })],
};
const VIEWS: Record<string, NoteView> = {
  n1: aNoteView({ id: 'n1', title: 'daemon-protocol', rev: 3, bodyMd: 'Original body' }),
  n2: aNoteView({ id: 'n2', title: 'voice', bodyMd: 'Voice body' }),
  n9: aNoteView({ id: 'n9', title: 'other-note', projectId: 'p2', bodyMd: 'Other body' }),
};

const page = <T>(items: T[], extra: { total?: number } = {}) => ({ items, total: extra.total ?? items.length, limit: 100, offset: 0 });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
let renderedView: { fixture: { whenStable(): Promise<unknown> } };
const flushPendingWork = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await renderedView.fixture.whenStable();
};
const staleRevision = () => new ApiError(409, 'stale', 'stale_revision');

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue(page([OPENFLEET, OTHER])),
    listNotes: vi.fn((projectId: string) => Promise.resolve(page(SUMMARIES[projectId] ?? []))),
    getNote: vi.fn((_projectId: string, noteId: string) => Promise.resolve(VIEWS[noteId])),
    createNote: vi.fn().mockResolvedValue(aNoteView({ id: 'new', title: 'Untitled note', bodyMd: '' })),
    updateNote: vi.fn().mockResolvedValue(aNoteView({ id: 'n1', rev: 6, bodyMd: 'updated' })),
    listNoteVersions: vi.fn().mockResolvedValue(page([aNoteVersion({ id: 'v1', rev: 1 }), aNoteVersion({ id: 'v2', rev: 2 })])),
    restoreNoteVersion: vi.fn().mockResolvedValue(aNoteView({ id: 'n1', rev: 4, bodyMd: 'Restored body' })),
    ...overrides,
  };
}

async function renderView(options: { api?: ReturnType<typeof fakeApi>; queryParams?: BehaviorSubject<ReturnType<typeof convertToParamMap>> } = {}) {
  const api = options.api ?? fakeApi();
  const queryParamMap = options.queryParams ?? new BehaviorSubject(convertToParamMap({}));
  renderedView = await render(NotesViewComponent, {
    providers: [
      provideRouter([]),
      { provide: FleetApiService, useValue: api },
      { provide: DirectoryOpener, useValue: { isAvailable: true, open: vi.fn().mockResolvedValue(undefined) } },
      { provide: ActivatedRoute, useValue: { queryParamMap } },
    ],
  });
  return { api, queryParamMap };
}

const editorTitle = () => screen.findByTestId('note-editor-title');
const expectEditorTitle = (title: string) => waitFor(() => expect(screen.getByTestId('note-editor-title')).toHaveTextContent(title));
const openHistoryAndSelectRev1 = async () => {
  await userEvent.click(screen.getByTestId('note-editor-history-toggle'));
  await userEvent.click(await screen.findByTestId('note-history-version-1'));
};
const restoreSelectedVersion = async () => {
  await openHistoryAndSelectRev1();
  await userEvent.click(screen.getByTestId('note-history-restore'));
};
const withLatestNoteOnSecondRead = (latest: NoteView) => {
  let getNoteCalls = 0;
  return vi.fn((_projectId: string, noteId: string) => {
    getNoteCalls += 1;
    return Promise.resolve(getNoteCalls === 2 ? latest : VIEWS[noteId]);
  });
};
const conflictingRestoreApi = (overrides: Record<string, unknown> = {}) =>
  fakeApi({
    getNote: withLatestNoteOnSecondRead(aNoteView({ id: 'n1', rev: 5, bodyMd: 'theirs' })),
    restoreNoteVersion: vi.fn().mockRejectedValue(staleRevision()),
    ...overrides,
  });

describe('notes view resists out-of-order answers', () => {
  it('a restore still running for a note never overwrites the note the user opened meanwhile', async () => {
    const restore = deferred<NoteView>();
    await renderView({ api: fakeApi({ restoreNoteVersion: vi.fn(() => restore.promise) }) });
    await editorTitle();
    await restoreSelectedVersion();

    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await expectEditorTitle('voice');
    restore.resolve(aNoteView({ id: 'n1', title: 'daemon-protocol', rev: 4, bodyMd: 'Restored body' }));
    await flushPendingWork();

    expect(screen.getByTestId('note-editor-title')).toHaveTextContent('voice');
    expect(screen.getByTestId('note-editor-body')).toHaveTextContent('Voice body');
  });

  it.each(['answers', 'fails'] as const)('the notes of an abandoned project never touch the current list when they %s late', async (lateOutcome) => {
    const slowOtherProject = deferred<ReturnType<typeof page<NoteSummary>>>();
    const api = fakeApi({
      listNotes: vi.fn((projectId: string) => (projectId === 'p2' ? slowOtherProject.promise : Promise.resolve(page(SUMMARIES[projectId] ?? [])))),
    });
    await renderView({ api });
    await editorTitle();
    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p2');
    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p1');
    await screen.findByTestId('note-list-item-n1');

    if (lateOutcome === 'answers') slowOtherProject.resolve(page(SUMMARIES['p2']!));
    else slowOtherProject.reject(new ApiError(500, 'GET /api/notes → 500'));
    await flushPendingWork();

    expect(screen.queryByTestId('note-list-item-n9')).not.toBeInTheDocument();
    expect(screen.queryByTestId('note-error-title')).not.toBeInTheDocument();
    expect(screen.getByTestId('note-editor-title')).toHaveTextContent('daemon-protocol');
  });

  it.each([
    {
      leaving: 'for another note',
      leave: () => userEvent.click(screen.getByTestId('note-list-item-n2')),
      expectStillShown: () => expect(screen.getByTestId('note-editor-title')).toHaveTextContent('voice'),
    },
    {
      leaving: 'for an empty project',
      leave: () => userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p3'),
      expectStillShown: () => expect(screen.getByTestId('note-empty-headline')).toBeInTheDocument(),
    },
  ])('a note still loading never shows up once the user left $leaving', async ({ leave, expectStillShown }) => {
    const slowNote = deferred<NoteView>();
    const getNote = vi.fn((_projectId: string, noteId: string) => (noteId === 'n1' ? slowNote.promise : Promise.resolve(VIEWS[noteId])));
    const api = fakeApi({ getNote, listProjects: vi.fn().mockResolvedValue(page([OPENFLEET, EMPTY_PROJECT])) });
    await renderView({ api });
    await screen.findByTestId('note-list-item-n1');
    await leave();
    await waitFor(expectStillShown);

    slowNote.resolve(VIEWS['n1']!);
    await flushPendingWork();

    expectStillShown();
    expect(screen.queryByText('Original body')).not.toBeInTheDocument();
  });

  it('the sidebar does not offer the notes of the previous project while the next project loads', async () => {
    const slowOtherProject = deferred<ReturnType<typeof page<NoteSummary>>>();
    const api = fakeApi({
      listNotes: vi.fn((projectId: string) => (projectId === 'p2' ? slowOtherProject.promise : Promise.resolve(page(SUMMARIES[projectId] ?? [])))),
    });
    await renderView({ api });
    await editorTitle();

    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p2');

    expect(screen.queryByTestId('note-list-item-n1')).not.toBeInTheDocument();
  });

  it('a conflict found for a note the user left never shows its banner over the next note', async () => {
    const latest = deferred<NoteView>();
    let getNoteCalls = 0;
    const getNote = vi.fn((_projectId: string, noteId: string) => {
      getNoteCalls += 1;
      const isConflictLookup = noteId === 'n1' && getNoteCalls > 1;
      return isConflictLookup ? latest.promise : Promise.resolve(VIEWS[noteId]);
    });
    await renderView({ api: fakeApi({ getNote, restoreNoteVersion: vi.fn().mockRejectedValue(staleRevision()) }) });
    await editorTitle();
    await restoreSelectedVersion();
    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await expectEditorTitle('voice');

    latest.resolve(aNoteView({ id: 'n1', rev: 9, bodyMd: 'theirs' }));
    await flushPendingWork();

    expect(screen.queryByTestId('note-conflict-bar')).not.toBeInTheDocument();
  });

  it('a note that fails to load after the user opened another note leaves the other note on screen', async () => {
    const slowNote = deferred<NoteView>();
    const getNote = vi.fn((_projectId: string, noteId: string) => (noteId === 'n1' ? slowNote.promise : Promise.resolve(VIEWS[noteId])));
    await renderView({ api: fakeApi({ getNote }) });
    await screen.findByTestId('note-list-item-n1');
    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await expectEditorTitle('voice');

    slowNote.reject(new ApiError(500, 'GET note → 500'));
    await flushPendingWork();

    expect(screen.queryByTestId('note-error-title')).not.toBeInTheDocument();
    expect(screen.getByTestId('note-editor-title')).toHaveTextContent('voice');
  });

  it('a restore failing after the user left the note raises no alert on the next note', async () => {
    const restore = deferred<NoteView>();
    await renderView({ api: fakeApi({ restoreNoteVersion: vi.fn(() => restore.promise) }) });
    await editorTitle();
    await restoreSelectedVersion();
    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await expectEditorTitle('voice');

    restore.reject(new ApiError(500, 'POST restore → 500'));
    await flushPendingWork();

    expect(screen.queryByTestId('note-action-error')).not.toBeInTheDocument();
  });

  it('a conflict whose author lookup answers after the user left the note never shows its banner', async () => {
    const authorLookup = deferred<ReturnType<typeof page<ReturnType<typeof aNoteVersion>>>>();
    const listNoteVersions = vi.fn().mockResolvedValueOnce(page([aNoteVersion({ id: 'v1', rev: 1 })])).mockReturnValueOnce(authorLookup.promise);
    await renderView({ api: conflictingRestoreApi({ listNoteVersions }) });
    await editorTitle();
    await restoreSelectedVersion();
    await waitFor(() => expect(listNoteVersions).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await expectEditorTitle('voice');

    authorLookup.resolve(page([aNoteVersion({ id: 'v5', rev: 5, author: 'Nori' })]));
    await flushPendingWork();

    expect(screen.queryByTestId('note-conflict-bar')).not.toBeInTheDocument();
  });

  it('a restore still running when the user switches project does not turn the new project into an error', async () => {
    const restore = deferred<NoteView>();
    const api = fakeApi({
      restoreNoteVersion: vi.fn(() => restore.promise),
      listNoteVersions: vi
        .fn()
        .mockResolvedValueOnce(page([aNoteVersion({ id: 'v1', rev: 1 })]))
        .mockRejectedValue(new ApiError(404, 'GET versions → 404')),
    });
    await renderView({ api });
    await editorTitle();
    await restoreSelectedVersion();
    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p2');
    await expectEditorTitle('other-note');

    restore.resolve(aNoteView({ id: 'n1', rev: 4, bodyMd: 'Restored body' }));
    await flushPendingWork();

    expect(screen.queryByTestId('note-error-title')).not.toBeInTheDocument();
    expect(screen.getByTestId('note-editor-title')).toHaveTextContent('other-note');
  });

  it('the versions of a note the user left while its history was loading never reach the next note', async () => {
    const slowVersions = deferred<ReturnType<typeof page<ReturnType<typeof aNoteVersion>>>>();
    const api = fakeApi({ listNoteVersions: vi.fn().mockReturnValueOnce(slowVersions.promise).mockResolvedValue(page([])) });
    await renderView({ api });
    await editorTitle();
    await userEvent.click(screen.getByTestId('note-editor-history-toggle'));
    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await expectEditorTitle('voice');
    await userEvent.click(screen.getByTestId('note-editor-history-toggle'));

    slowVersions.resolve(page([aNoteVersion({ id: 'stale', rev: 77 })]));
    await flushPendingWork();

    expect(screen.queryByTestId('note-history-version-77')).not.toBeInTheDocument();
  });

  it('opening another note closes the history of the previous one', async () => {
    await renderView();
    await editorTitle();
    await userEvent.click(screen.getByTestId('note-editor-history-toggle'));
    await screen.findByTestId('note-history-restore');

    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await expectEditorTitle('voice');

    expect(screen.queryByTestId('note-history-restore')).not.toBeInTheDocument();
  });

  it('opening another note drops the conflict banner of the previous one', async () => {
    await renderView({ api: conflictingRestoreApi() });
    await editorTitle();
    await restoreSelectedVersion();
    await screen.findByTestId('note-conflict-bar');

    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await expectEditorTitle('voice');

    expect(screen.queryByTestId('note-conflict-bar')).not.toBeInTheDocument();
  });
});

describe('notes view tells the user when something failed', () => {
  it('user is told when the history could not be loaded and can retry', async () => {
    const listNoteVersions = vi.fn().mockRejectedValueOnce(new ApiError(500, 'GET versions → 500')).mockResolvedValue(page([aNoteVersion({ id: 'v1', rev: 1 })]));
    await renderView({ api: fakeApi({ listNoteVersions }) });
    await editorTitle();

    await userEvent.click(screen.getByTestId('note-editor-history-toggle'));

    expect(await screen.findByTestId('note-history-error')).toHaveTextContent('500');
    await userEvent.click(screen.getByTestId('note-history-retry'));
    expect(await screen.findByTestId('note-history-version-1')).toBeInTheDocument();
    expect(screen.queryByTestId('note-history-error')).not.toBeInTheDocument();
  });

  it('user is not left without feedback when the note cannot be re-read after a restore conflict', async () => {
    let getNoteCalls = 0;
    const getNote = vi.fn((_projectId: string, noteId: string) => {
      getNoteCalls += 1;
      return getNoteCalls > 1 ? Promise.reject(new ApiError(0, 'daemon unreachable')) : Promise.resolve(VIEWS[noteId]);
    });
    await renderView({ api: fakeApi({ getNote, restoreNoteVersion: vi.fn().mockRejectedValue(staleRevision()) }) });
    await editorTitle();

    await restoreSelectedVersion();

    expect(await screen.findByTestId('note-error-reason')).toHaveTextContent('daemon unreachable');
  });

  it('a restore that succeeded stays visible when the history reload fails afterwards', async () => {
    const api = fakeApi({
      listNoteVersions: vi
        .fn()
        .mockResolvedValueOnce(page([aNoteVersion({ id: 'v1', rev: 1 })]))
        .mockRejectedValue(new ApiError(500, 'boom')),
    });
    await renderView({ api });
    await editorTitle();

    await restoreSelectedVersion();

    expect(await screen.findByTestId('note-history-error')).toBeInTheDocument();
    expect(screen.queryByTestId('note-error-title')).not.toBeInTheDocument();
    expect(screen.getByTestId('note-editor-body')).toHaveTextContent('Restored body');
  });

  it('a failing note creation says why, keeps the open note on screen and can be dismissed', async () => {
    const api = fakeApi({ createNote: vi.fn().mockRejectedValue(new ApiError(500, 'POST /api/notes → 500')) });
    await renderView({ api });
    await editorTitle();

    await userEvent.click(screen.getByTestId('note-list-new'));

    expect(await screen.findByTestId('note-action-error-title')).toHaveTextContent('Couldn’t create the note');
    expect(screen.getByTestId('note-action-error-reason')).toHaveTextContent('POST /api/notes → 500');
    expect(screen.getByTestId('note-editor-title')).toHaveTextContent('daemon-protocol');
    await userEvent.click(screen.getByTestId('note-action-error-dismiss'));
    expect(screen.queryByTestId('note-action-error')).not.toBeInTheDocument();
  });

  it.each([
    { status: 500, code: 'internal_error' },
    { status: 413, code: 'note_too_large' },
    { status: 409, code: 'file_backed' },
    { status: 404, code: 'not_found' },
  ])('a conflict resolution failing with $status is reported inline and leaves the note and the choices in place', async ({ status, code }) => {
    const restoreNoteVersion = vi.fn().mockRejectedValueOnce(staleRevision()).mockRejectedValue(new ApiError(status, `POST restore → ${status}`, code));
    const api = conflictingRestoreApi({ restoreNoteVersion });
    await renderView({ api });
    await editorTitle();
    await restoreSelectedVersion();
    await userEvent.click(await screen.findByTestId('note-conflict-restore'));

    expect(await screen.findByTestId('note-action-error-reason')).toHaveTextContent(String(status));
    expect(screen.getByTestId('note-editor-title')).toHaveTextContent('daemon-protocol');
    expect(screen.queryByTestId('note-error-title')).not.toBeInTheDocument();
    expect(screen.getByTestId('note-conflict-restore')).toBeEnabled();
  });

  it('a restore failing with a server error is reported inline and leaves the note in place', async () => {
    const api = fakeApi({ restoreNoteVersion: vi.fn().mockRejectedValue(new ApiError(500, 'POST restore → 500', 'internal_error')) });
    await renderView({ api });
    await editorTitle();

    await restoreSelectedVersion();

    expect(await screen.findByTestId('note-action-error-title')).toHaveTextContent('Couldn’t restore the version');
    expect(screen.getByTestId('note-action-error-reason')).toHaveTextContent('500');
    expect(screen.getByTestId('note-editor-body')).toHaveTextContent('Original body');
    expect(screen.queryByTestId('note-error-title')).not.toBeInTheDocument();
  });

  it('the failure alert of a note never follows the user to the next note', async () => {
    await renderView({ api: fakeApi({ restoreNoteVersion: vi.fn().mockRejectedValue(new ApiError(500, 'boom')) }) });
    await editorTitle();
    await restoreSelectedVersion();
    await screen.findByTestId('note-action-error');

    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await expectEditorTitle('voice');

    expect(screen.queryByTestId('note-action-error')).not.toBeInTheDocument();
  });

  it('a second concurrent edit during restore anyway shows a fresh banner that holds the user’s text', async () => {
    const firstLatest = aNoteView({ id: 'n1', rev: 5, bodyMd: 'theirs at rev 5' });
    const secondLatest = aNoteView({ id: 'n1', rev: 6, bodyMd: 'theirs at rev 6' });
    let getNoteCalls = 0;
    const getNote = vi.fn((_projectId: string, noteId: string) => {
      getNoteCalls += 1;
      if (getNoteCalls === 2) return Promise.resolve(firstLatest);
      return Promise.resolve(getNoteCalls >= 3 ? secondLatest : VIEWS[noteId]);
    });
    const api = conflictingRestoreApi({ getNote, restoreNoteVersion: vi.fn().mockRejectedValue(staleRevision()) });
    await renderView({ api });
    await editorTitle();
    await restoreSelectedVersion();
    await userEvent.click(await screen.findByTestId('note-conflict-restore'));

    await waitFor(() => expect(api.restoreNoteVersion).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(screen.getByTestId('note-conflict-theirs')).toHaveTextContent('theirs at rev 6'));
    expect(screen.getByTestId('note-conflict-ours')).toHaveTextContent('Original body');
    expect(screen.getByTestId('note-conflict-restore')).toBeEnabled();
    expect(screen.getByTestId('note-conflict-keep-current')).toBeEnabled();
    await userEvent.click(screen.getByTestId('note-conflict-restore'));
    await waitFor(() => expect(api.restoreNoteVersion).toHaveBeenCalledTimes(3));
    expect(api.restoreNoteVersion).toHaveBeenLastCalledWith('p1', 'n1', { rev: 1, expectedRev: 6 });
  });

  describe('the author named in a conflict banner', () => {
    const pageOf = <T>(all: T[]) =>
      vi.fn((...args: unknown[]) => {
        const { limit = 200, offset = 0 } = (args.at(-1) ?? {}) as { limit?: number; offset?: number };
        return Promise.resolve({ items: all.slice(offset, offset + limit), total: all.length, limit, offset });
      });

    it('is read from the last page of a long history, without walking the pages before it', async () => {
      const revisions = Array.from({ length: 450 }, (_, index) =>
        aNoteVersion({ id: `v${index + 1}`, rev: index + 1, author: index + 1 === 450 ? 'Nori · T7' : 'You' }),
      );
      const listNoteVersions = pageOf(revisions);
      const getNote = withLatestNoteOnSecondRead(aNoteView({ id: 'n1', rev: 450, bodyMd: 'theirs' }));
      await renderView({ api: fakeApi({ getNote, listNoteVersions, restoreNoteVersion: vi.fn().mockRejectedValue(staleRevision()) }) });
      await editorTitle();
      await openHistoryAndSelectRev1();
      const callsBeforeRestore = listNoteVersions.mock.calls.length;

      await userEvent.click(screen.getByTestId('note-history-restore'));

      await waitFor(() => expect(screen.getByTestId('note-conflict-theirs')).toHaveTextContent('Nori · T7'));
      expect(listNoteVersions.mock.calls.slice(callsBeforeRestore).map(([, , request]) => request)).toEqual([
        { limit: 200, offset: 0 },
        { limit: 200, offset: 250 },
      ]);
    });

    it('is named “Another editor” when the history cannot be read', async () => {
      const listNoteVersions = vi.fn().mockResolvedValueOnce(page([aNoteVersion({ id: 'v1', rev: 1 })])).mockRejectedValue(new ApiError(500, 'GET versions → 500'));
      await renderView({ api: conflictingRestoreApi({ listNoteVersions }) });
      await editorTitle();

      await restoreSelectedVersion();

      await waitFor(() => expect(screen.getByTestId('note-conflict-theirs')).toHaveTextContent('Another editor'));
    });

    it('is read together with a refresh of the open history, which then lists the concurrent revision', async () => {
      const listNoteVersions = vi
        .fn()
        .mockResolvedValueOnce(page([aNoteVersion({ id: 'v1', rev: 1 })]))
        .mockResolvedValue(page([aNoteVersion({ id: 'v1', rev: 1 }), aNoteVersion({ id: 'v5', rev: 5, author: 'Nori · T7' })]));
      await renderView({ api: conflictingRestoreApi({ listNoteVersions }) });
      await editorTitle();

      await restoreSelectedVersion();

      await waitFor(() => expect(screen.getByTestId('note-conflict-theirs')).toHaveTextContent('Nori · T7'));
      expect(screen.getByTestId('note-history-version-5')).toBeInTheDocument();
      expect(listNoteVersions).toHaveBeenCalledTimes(2);
    });
  });

  it('user can retry the project list after a network error, with no Finder shortcut on offer', async () => {
    const listProjects = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(page([OPENFLEET]));
    await renderView({ api: fakeApi({ listProjects }) });

    expect(await screen.findByTestId('note-error-reason')).toHaveTextContent('Failed to fetch');
    expect(screen.queryByTestId('note-error-open-in-finder')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('note-error-retry'));

    expect(await editorTitle()).toHaveTextContent('daemon-protocol');
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it('user sees the reason when a note was deleted elsewhere', async () => {
    const api = fakeApi({ getNote: vi.fn().mockRejectedValue(new ApiError(404, 'GET /api/notes/n1 → 404', 'not_found')) });
    await renderView({ api });

    expect(await screen.findByTestId('note-error-reason')).toHaveTextContent('404');
  });

  it('the restore button is usable again once a restore conflict is resolved by keeping the current note', async () => {
    const freshVersions = () => Promise.resolve(page([aNoteVersion({ id: 'v1', rev: 1 })]));
    const api = conflictingRestoreApi({ listNoteVersions: vi.fn(freshVersions) });
    await renderView({ api });
    await editorTitle();
    await restoreSelectedVersion();
    await userEvent.click(await screen.findByTestId('note-conflict-keep-current'));

    await userEvent.click(await screen.findByTestId('note-history-version-1'));
    await waitFor(() => expect(screen.getByTestId('note-history-restore')).toBeEnabled());
  });
});

describe('notes view protects against double submits', () => {
  it('double-clicking “+” creates a single note', async () => {
    const creation = deferred<NoteView>();
    const api = fakeApi({ createNote: vi.fn(() => creation.promise) });
    await renderView({ api });
    await editorTitle();

    await userEvent.dblClick(screen.getByTestId('note-list-new'));
    creation.resolve(aNoteView({ id: 'new', title: 'Untitled note', bodyMd: '' }));
    await flushPendingWork();

    expect(api.createNote).toHaveBeenCalledTimes(1);
  });

  it('double-clicking the create button of the empty state creates a single note', async () => {
    const creation = deferred<NoteView>();
    const api = fakeApi({ listNotes: vi.fn().mockResolvedValue(page([])), createNote: vi.fn(() => creation.promise) });
    await renderView({ api });

    await userEvent.dblClick(await screen.findByTestId('note-empty-create'));
    creation.resolve(aNoteView({ id: 'new', title: 'Untitled note', bodyMd: '' }));
    await flushPendingWork();

    expect(api.createNote).toHaveBeenCalledTimes(1);
  });

  it('the plus button is disabled while a note is being created', async () => {
    const creation = deferred<NoteView>();
    await renderView({ api: fakeApi({ createNote: vi.fn(() => creation.promise) }) });
    await editorTitle();

    await userEvent.click(screen.getByTestId('note-list-new'));

    expect(screen.getByTestId('note-list-new')).toBeDisabled();
    creation.resolve(aNoteView({ id: 'new', title: 'Untitled note', bodyMd: '' }));
  });

  it('double-clicking Restore posts a single restore', async () => {
    const restore = deferred<NoteView>();
    const api = fakeApi({ restoreNoteVersion: vi.fn(() => restore.promise) });
    await renderView({ api });
    await editorTitle();
    await openHistoryAndSelectRev1();

    await userEvent.dblClick(screen.getByTestId('note-history-restore'));
    restore.resolve(aNoteView({ id: 'n1', rev: 4, bodyMd: 'Restored body' }));
    await flushPendingWork();

    expect(api.restoreNoteVersion).toHaveBeenCalledTimes(1);
  });

  it('double-clicking Restore anyway writes once', async () => {
    const write = deferred<NoteView>();
    const restoreNoteVersion = vi.fn().mockRejectedValueOnce(staleRevision()).mockImplementation(() => write.promise);
    const api = conflictingRestoreApi({ restoreNoteVersion });
    await renderView({ api });
    await editorTitle();
    await restoreSelectedVersion();

    await userEvent.dblClick(await screen.findByTestId('note-conflict-restore'));
    write.resolve(aNoteView({ id: 'n1', rev: 6, bodyMd: 'written' }));
    await flushPendingWork();

    expect(api.restoreNoteVersion).toHaveBeenCalledTimes(2);
  });

  it('double-clicking a list item fetches the note once', async () => {
    const api = fakeApi();
    await renderView({ api });
    await editorTitle();
    const callsBefore = api.getNote.mock.calls.length;

    await userEvent.dblClick(screen.getByTestId('note-list-item-n2'));
    await flushPendingWork();

    expect(api.getNote.mock.calls.length - callsBefore).toBe(1);
  });
});

describe('notes view shows every note of a project', () => {
  const daemonPagesOf = <T>(all: T[]) =>
    vi.fn((...args: unknown[]) => {
      const { limit = 200, offset = 0 } = (args.at(-1) ?? {}) as { limit?: number; offset?: number };
      return Promise.resolve({ items: all.slice(offset, offset + limit), total: all.length, limit, offset });
    });

  it('user finds a note that sits beyond the first page of the daemon', async () => {
    const notes = Array.from({ length: 250 }, (_, index) => aNoteSummary({ id: `n${index}`, title: `note ${index}` }));
    const listNotes = daemonPagesOf(notes);
    const getNote = vi.fn((_projectId: string, noteId: string) => Promise.resolve(aNoteView({ id: noteId, bodyMd: '' })));
    await renderView({ api: fakeApi({ listNotes, getNote }) });

    expect(await screen.findByTestId('note-list-item-n249')).toBeInTheDocument();
    expect(listNotes).toHaveBeenLastCalledWith('p1', { limit: 200, offset: 200 });
  });

  it('user sees the whole history of a note, newest revision first, even when the daemon lists it oldest first', async () => {
    const revisions = Array.from({ length: 450 }, (_, index) => aNoteVersion({ id: `v${index + 1}`, rev: index + 1 }));
    await renderView({ api: fakeApi({ listNoteVersions: daemonPagesOf(revisions) }) });
    await editorTitle();

    await userEvent.click(screen.getByTestId('note-editor-history-toggle'));

    expect(await screen.findByTestId('note-history-version-1')).toBeInTheDocument();
    const revsOnScreen = screen.getAllByTestId(/^note-history-version-/).map((row) => Number(row.dataset['testid']!.split('-').at(-1)));
    expect(revsOnScreen).toEqual(Array.from({ length: 450 }, (_, index) => 450 - index));
  });

  it('a project list longer than one page is fully loaded', async () => {
    const listProjects = vi
      .fn()
      .mockResolvedValueOnce({ items: [OPENFLEET], total: 2, limit: 1, offset: 0 })
      .mockResolvedValueOnce({ items: [OTHER], total: 2, limit: 1, offset: 1 });
    await renderView({ api: fakeApi({ listProjects }) });
    await editorTitle();

    expect(listProjects).toHaveBeenLastCalledWith({ limit: 200, offset: 1 });
    expect(screen.getByTestId('notes-project-select')).toHaveTextContent('Other');
  });

  it('a note created while the user leaves and comes back to the project is listed once', async () => {
    const creation = deferred<NoteView>();
    let isCreatedOnDaemon = false;
    const createdSummary = aNoteSummary({ id: 'new', title: 'Untitled note' });
    const listNotes = vi.fn((projectId: string) =>
      Promise.resolve(page(projectId === 'p1' && isCreatedOnDaemon ? [createdSummary, ...SUMMARIES['p1']!] : (SUMMARIES[projectId] ?? []))),
    );
    const getNote = vi.fn((_projectId: string, noteId: string) => Promise.resolve(noteId === 'new' ? aNoteView({ id: 'new', title: 'Untitled note', bodyMd: '' }) : VIEWS[noteId]));
    await renderView({ api: fakeApi({ listNotes, getNote, createNote: vi.fn(() => creation.promise) }) });
    await editorTitle();
    await userEvent.click(screen.getByTestId('note-list-new'));
    isCreatedOnDaemon = true;
    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p2');
    await screen.findByTestId('note-list-item-n9');
    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p1');
    await screen.findByTestId('note-list-item-new');

    creation.resolve(aNoteView({ id: 'new', title: 'Untitled note', bodyMd: '' }));
    await flushPendingWork();

    expect(screen.getAllByTestId('note-list-item-new')).toHaveLength(1);
  });
});

describe('notes view keeps a slow note creation from disturbing what the user does meanwhile', () => {
  const createdNote = () => aNoteView({ id: 'new', title: 'Untitled note', bodyMd: '' });

  it('a created note does not steal the editor from a note the user selected while waiting', async () => {
    const creation = deferred<NoteView>();
    await renderView({ api: fakeApi({ createNote: vi.fn(() => creation.promise) }) });
    await editorTitle();
    await userEvent.click(screen.getByTestId('note-list-new'));
    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await expectEditorTitle('voice');

    creation.resolve(createdNote());
    await flushPendingWork();

    expect(screen.getByTestId('note-editor-title')).toHaveTextContent('voice');
    expect(screen.getByTestId('note-list-item-new')).toBeInTheDocument();
  });

  it('a note creation failing after the user moved to another project raises no alert there', async () => {
    const creation = deferred<NoteView>();
    await renderView({ api: fakeApi({ createNote: vi.fn(() => creation.promise) }) });
    await editorTitle();
    await userEvent.click(screen.getByTestId('note-list-new'));
    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p2');
    await screen.findByTestId('note-list-item-n9');

    creation.reject(new ApiError(500, 'POST /api/notes → 500'));
    await flushPendingWork();

    expect(screen.queryByTestId('note-action-error')).not.toBeInTheDocument();
  });

  it('a creation answered after the user left the project and came back does not overwrite the reloaded list', async () => {
    const creation = deferred<NoteView>();
    await renderView({ api: fakeApi({ createNote: vi.fn(() => creation.promise) }) });
    await editorTitle();
    await userEvent.click(screen.getByTestId('note-list-new'));
    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p2');
    await screen.findByTestId('note-list-item-n9');
    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p1');
    await screen.findByTestId('note-list-item-n2');

    creation.resolve(createdNote());
    await flushPendingWork();

    expect(screen.queryByTestId('note-list-item-new')).not.toBeInTheDocument();
  });

  it('user can create a note in the new project while a creation from the previous project is still pending', async () => {
    const creation = deferred<NoteView>();
    await renderView({ api: fakeApi({ createNote: vi.fn(() => creation.promise) }) });
    await editorTitle();
    await userEvent.click(screen.getByTestId('note-list-new'));
    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p2');
    await screen.findByTestId('note-list-item-n9');

    expect(screen.getByTestId('note-list-new')).toBeEnabled();
  });

  it('the create button stays disabled while the creation of the current project is in flight, even if the previous project answers', async () => {
    const creationA = deferred<NoteView>();
    const creationB = deferred<NoteView>();
    const createNote = vi.fn().mockReturnValueOnce(creationA.promise).mockReturnValueOnce(creationB.promise);
    await renderView({ api: fakeApi({ createNote }) });
    await editorTitle();
    await userEvent.click(screen.getByTestId('note-list-new'));
    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p2');
    await screen.findByTestId('note-list-item-n9');
    await userEvent.click(screen.getByTestId('note-list-new'));

    creationA.resolve(createdNote());
    await flushPendingWork();

    expect(screen.getByTestId('note-list-new')).toBeDisabled();
  });

  it('user can type right away in a note created from the empty state', async () => {
    const api = fakeApi({ listNotes: vi.fn().mockResolvedValue(page([])), getNote: vi.fn().mockResolvedValue(createdNote()) });
    await renderView({ api });

    await userEvent.click(await screen.findByTestId('note-empty-create'));

    await waitFor(() => expect(screen.getByTestId('note-editor-title')).toHaveFocus());
  });
});

describe('notes view is usable from the keyboard and by assistive technology', () => {
  it('Enter on a focused list item opens the note', async () => {
    await renderView();
    await editorTitle();

    screen.getByTestId('note-list-item-n2').focus();
    await userEvent.keyboard('{Enter}');

    await expectEditorTitle('voice');
  });

  it('Space on the history toggle opens the history', async () => {
    await renderView();
    await editorTitle();

    screen.getByTestId('note-editor-history-toggle').focus();
    await userEvent.keyboard(' ');

    expect(await screen.findByTestId('note-history-restore')).toBeInTheDocument();
  });

  it('a version can be restored with the keyboard only', async () => {
    const api = fakeApi();
    await renderView({ api });
    await editorTitle();
    screen.getByTestId('note-editor-history-toggle').focus();
    await userEvent.keyboard('{Enter}');
    (await screen.findByTestId('note-history-version-1')).focus();
    await userEvent.keyboard(' ');
    screen.getByTestId('note-history-restore').focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(api.restoreNoteVersion).toHaveBeenCalledTimes(1));
  });

  it('history versions expose their selection with aria-pressed, not aria-selected', async () => {
    await renderView();
    await editorTitle();
    await userEvent.click(screen.getByTestId('note-editor-history-toggle'));

    const version = await screen.findByTestId('note-history-version-1');

    expect(version).not.toHaveAttribute('aria-selected');
    expect(version).toHaveAttribute('aria-pressed', 'false');
  });

  it('the loading skeleton is announced as a busy status', async () => {
    await renderView({ api: fakeApi({ listProjects: vi.fn(() => new Promise(() => undefined)) }) });

    const skeleton = screen.getByTestId('note-skeleton');

    expect(skeleton).toHaveAttribute('role', 'status');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
  });

  it('focus moves to the note after the user resolves a conflict', async () => {
    await renderView({ api: conflictingRestoreApi() });
    await editorTitle();
    await restoreSelectedVersion();
    await userEvent.click(await screen.findByTestId('note-conflict-keep-current'));

    await waitFor(() => expect(screen.getByTestId('note-editor-title')).toHaveFocus());
  });

  it('focus moves to the note after a successful retry', async () => {
    const getNote = vi.fn().mockRejectedValueOnce(new ApiError(500, 'boom')).mockResolvedValue(VIEWS['n1']);
    await renderView({ api: fakeApi({ getNote }) });
    await userEvent.click(await screen.findByTestId('note-error-retry'));

    await waitFor(() => expect(screen.getByTestId('note-editor-title')).toHaveFocus());
  });

  it('opening a note from the list keeps the focus on the list', async () => {
    await renderView();
    await editorTitle();

    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await expectEditorTitle('voice');

    expect(screen.getByTestId('note-list-item-n2')).toHaveFocus();
  });

  it('the plus button is disabled when there is no project', async () => {
    await renderView({ api: fakeApi({ listProjects: vi.fn().mockResolvedValue(page([])) }) });
    await screen.findByTestId('notes-no-project');

    expect(screen.getByTestId('note-list-new')).toBeDisabled();
  });

  it('“No notes yet.” is not shown while the notes are loading', async () => {
    await renderView({ api: fakeApi({ listNotes: vi.fn(() => new Promise(() => undefined)) }) });
    await screen.findByTestId('note-skeleton');

    expect(screen.queryByTestId('note-list-empty')).not.toBeInTheDocument();
  });

  it('the project select is labelled', async () => {
    await renderView();
    await editorTitle();

    expect(screen.getByTestId('notes-project-select')).toHaveAccessibleName('Project');
  });
});

describe('notes view renders hostile content as text', () => {
  const HOSTILE_TITLE = '<img src=x onerror="window.__pwned=1">';
  const HOSTILE_BODY = '# <script>window.__pwned=1</script>\n\n<img src=x onerror="window.__pwned=1"> and `<b>code</b>`\n\n```\n<script>window.__pwned=1</script>\n```\n\n- <svg onload="window.__pwned=1">';
  const pwned = () => (window as unknown as { __pwned?: number }).__pwned;

  it('a hostile title, body and project name are displayed literally', async () => {
    const hostile = aNoteView({ id: 'n1', title: HOSTILE_TITLE, bodyMd: HOSTILE_BODY, docsRelativePath: '<b>x</b>/../a.md' });
    const api = fakeApi({
      listProjects: vi.fn().mockResolvedValue(page([{ id: 'p1', name: '<i>proj</i>', docsFolderPath: null }])),
      listNotes: vi.fn().mockResolvedValue(page([aNoteSummary({ id: 'n1', title: HOSTILE_TITLE })])),
      getNote: vi.fn().mockResolvedValue(hostile),
    });
    await renderView({ api });
    await editorTitle();

    expect(screen.getByTestId('note-editor-title')).toHaveTextContent(HOSTILE_TITLE);
    expect(screen.getByTestId('note-editor-path')).toHaveTextContent('<b>x</b>/../a.md');
    expect(screen.getByTestId('note-editor-body')).toHaveTextContent('<img src=x onerror="window.__pwned=1">');
    expect(screen.getByTestId('note-editor-body')).toHaveTextContent('<svg onload="window.__pwned=1">');
    expect(screen.getByTestId('note-editor-code-block')).toHaveTextContent('<script>window.__pwned=1</script>');
    expect(screen.getByTestId('note-editor-inline-code')).toHaveTextContent('<b>code</b>');
    expect(screen.getByTestId('notes-project-select')).toHaveTextContent('<i>proj</i>');
    expect(pwned()).toBeUndefined();
  });

});

describe('notes view renders unusual markdown', () => {
  const renderNoteWithBody = async (bodyMd: string) => {
    await renderView({ api: fakeApi({ getNote: vi.fn().mockResolvedValue(aNoteView({ id: 'n1', bodyMd })) }) });
    await editorTitle();
  };

  it('a note saved with Windows line endings keeps its headings and list items', async () => {
    await renderNoteWithBody('# Title\r\n\r\n- one\r\n- two\r\n');

    expect(screen.getByTestId('note-editor-heading-1')).toHaveTextContent('Title');
    expect(screen.getAllByTestId('note-editor-list-item')).toHaveLength(2);
  });

  it('an empty note says it is empty', async () => {
    await renderNoteWithBody('');

    expect(screen.getByTestId('note-editor-empty-body')).toBeInTheDocument();
  });

  it('a note with content does not show the empty placeholder', async () => {
    await renderNoteWithBody('hello');

    expect(screen.queryByTestId('note-editor-empty-body')).not.toBeInTheDocument();
  });

  it('an unclosed backtick stays plain text', async () => {
    await renderNoteWithBody('price is 5` and more text');

    expect(screen.queryByTestId('note-editor-inline-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('note-editor-body')).toHaveTextContent('price is 5` and more text');
  });

  it('a very long line that looks like a mention renders in under two seconds', async () => {
    const startedAt = performance.now();

    await renderNoteWithBody(`--- from note @note:a (${', '.repeat(150_000)}`);

    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it.each(['#', '-'])('a huge run of spaces after "%s" and a line separator renders in under two seconds', async (marker) => {
    const startedAt = performance.now();

    await renderNoteWithBody(`${marker}${' '.repeat(200_000)}\u2028x`);

    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it('three thousand nested mention blocks still render', async () => {
    const opens = Array.from({ length: 3000 }, (_, index) => `--- from note @note:n${index} (t, d) ---`);
    const closes = Array.from({ length: 3000 }, (_, index) => `--- end @note:n${2999 - index} ---`);

    await renderNoteWithBody([...opens, 'x', ...closes].join('\n'));

    expect(screen.getByTestId('note-editor-title')).toBeInTheDocument();
  });
});

describe('notes view navigation', () => {
  it('a later ?projectId= change on the same screen switches the project', async () => {
    const queryParams = new BehaviorSubject(convertToParamMap({ projectId: 'p1' }));
    await renderView({ queryParams });
    await editorTitle();

    queryParams.next(convertToParamMap({ projectId: 'p2' }));

    await expectEditorTitle('other-note');
    expect(screen.getByTestId('notes-project-select')).toHaveValue('p2');
  });

  it('an unknown ?projectId= change leaves the current project alone', async () => {
    const queryParams = new BehaviorSubject(convertToParamMap({ projectId: 'p1' }));
    await renderView({ queryParams });
    await editorTitle();

    queryParams.next(convertToParamMap({ projectId: 'ghost' }));
    await flushPendingWork();

    expect(screen.getByTestId('note-editor-title')).toHaveTextContent('daemon-protocol');
  });

  it('clicking the note that is already open keeps a pending conflict banner', async () => {
    await renderView({ api: conflictingRestoreApi() });
    await editorTitle();
    await restoreSelectedVersion();
    await screen.findByTestId('note-conflict-bar');

    await userEvent.click(screen.getByTestId('note-list-item-n1'));
    await flushPendingWork();

    expect(screen.getByTestId('note-conflict-bar')).toBeInTheDocument();
  });

  it('clicking the note that is already open keeps the history open', async () => {
    const api = fakeApi();
    await renderView({ api });
    await editorTitle();
    await userEvent.click(screen.getByTestId('note-editor-history-toggle'));
    await screen.findByTestId('note-history-restore');
    const callsBefore = api.getNote.mock.calls.length;

    await userEvent.click(screen.getByTestId('note-list-item-n1'));
    await flushPendingWork();

    expect(screen.getByTestId('note-history-restore')).toBeInTheDocument();
    expect(api.getNote.mock.calls.length).toBe(callsBefore);
  });

  it('the filter is cleared when the project changes', async () => {
    await renderView();
    await editorTitle();
    await userEvent.type(screen.getByTestId('note-list-filter'), 'voice');

    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p2');
    await screen.findByTestId('note-list-item-n9');

    expect(screen.getByTestId('note-list-filter')).toHaveValue('');
  });

  it('a new note stays visible in the list even when the filter would hide it', async () => {
    const getNote = vi.fn((_projectId: string, noteId: string) => Promise.resolve(noteId === 'new' ? aNoteView({ id: 'new', title: 'Untitled note', bodyMd: '' }) : VIEWS[noteId]));
    await renderView({ api: fakeApi({ getNote }) });
    await editorTitle();
    await userEvent.type(screen.getByTestId('note-list-filter'), 'voice');

    await userEvent.click(screen.getByTestId('note-list-new'));
    await expectEditorTitle('Untitled note');

    expect(screen.getByTestId('note-list-item-new')).toBeInTheDocument();
  });

  it('a created note is the one that opens, not the first note of the list', async () => {
    const getNote = vi.fn((_projectId: string, noteId: string) => Promise.resolve(noteId === 'new' ? aNoteView({ id: 'new', title: 'Untitled note', bodyMd: 'fresh' }) : VIEWS[noteId]));
    await renderView({ api: fakeApi({ getNote }) });
    await editorTitle();

    await userEvent.click(screen.getByTestId('note-list-new'));

    await expectEditorTitle('Untitled note');
    expect(screen.getByTestId('note-list-item-new')).toHaveAttribute('aria-current', 'true');
  });

  it('a filter made of spaces hides nothing', async () => {
    await renderView();
    await editorTitle();

    await userEvent.type(screen.getByTestId('note-list-filter'), '   ');

    expect(screen.getByTestId('note-list-item-n1')).toBeInTheDocument();
    expect(screen.getByTestId('note-list-item-n2')).toBeInTheDocument();
  });

  it('a filter with no match shows the no-match hint and the note stays open', async () => {
    await renderView();
    await editorTitle();

    await userEvent.type(screen.getByTestId('note-list-filter'), 'zzz');

    expect(screen.getByTestId('note-list-no-match')).toHaveTextContent('zzz');
    expect(screen.getByTestId('note-editor-title')).toBeInTheDocument();
  });

  it('restoring the current revision is not offered', async () => {
    const api = fakeApi({ listNoteVersions: vi.fn().mockResolvedValue(page([aNoteVersion({ id: 'v1', rev: 1 }), aNoteVersion({ id: 'v3', rev: 3 })])) });
    await renderView({ api });
    await editorTitle();
    await userEvent.click(screen.getByTestId('note-editor-history-toggle'));

    await userEvent.click(await screen.findByTestId('note-history-version-3'));

    expect(screen.getByTestId('note-history-restore')).toBeDisabled();
  });
});

describe('notes view keeps the intent of a restore that hit a conflict', () => {
  it('user can restore the chosen version on top of the latest revision', async () => {
    const api = conflictingRestoreApi();
    await renderView({ api });
    await editorTitle();
    await restoreSelectedVersion();

    await userEvent.click(await screen.findByTestId('note-conflict-restore'));

    await waitFor(() => expect(api.restoreNoteVersion).toHaveBeenLastCalledWith('p1', 'n1', { rev: 1, expectedRev: 5 }));
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it('user cannot restore another version from the history while the conflict waits for their choice', async () => {
    await renderView({ api: conflictingRestoreApi() });
    await editorTitle();
    await restoreSelectedVersion();
    await screen.findByTestId('note-conflict-bar');

    expect(screen.getByTestId('note-history-restore')).toBeDisabled();
  });

  it('the restore choice names the version that will be restored', async () => {
    await renderView({ api: conflictingRestoreApi() });
    await editorTitle();
    await restoreSelectedVersion();

    expect(await screen.findByTestId('note-conflict-restore')).toHaveTextContent('Restore rev 1');
    expect(screen.getByTestId('note-conflict-ours')).toHaveTextContent('You had open');
  });
});
