import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { BehaviorSubject, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { DirectoryOpener } from './directory-opener';
import { NotesViewComponent } from './notes-view.component';
import { aNoteSummary, aNoteView } from './notes.fixtures';
import type { NoteChangeEvent, NoteSummary, NoteView, Project } from '@openfleet/shared';

const OPENFLEET: Project = { id: 'p1', name: 'OpenFleet', docsFolderPath: null };
const OTHER: Project = { id: 'p2', name: 'Other', docsFolderPath: null };
const QUIET_PERIOD_PASSED_MS = 900;

const summaries: Record<string, NoteSummary[]> = {
  p1: [aNoteSummary({ id: 'n1', title: 'daemon-protocol', rev: 3 }), aNoteSummary({ id: 'n2', title: 'voice', rev: 1 })],
  p2: [aNoteSummary({ id: 'n9', title: 'other-note' })],
};
const views: Record<string, NoteView> = {
  n1: aNoteView({ id: 'n1', title: 'daemon-protocol', rev: 3, bodyMd: 'Original body' }),
  n2: aNoteView({ id: 'n2', title: 'voice', rev: 1, bodyMd: 'Voice body' }),
  n9: aNoteView({ id: 'n9', title: 'other-note', projectId: 'p2', bodyMd: 'Other body' }),
};
const refreshedN1 = (rev = 4) => aNoteView({ id: 'n1', title: 'daemon-protocol', rev, bodyMd: 'Fresh body written by an agent' });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const page = <T>(items: T[]) => ({ items, total: items.length, limit: 200, offset: 0 });
const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const updated = (noteId: string, rev: number, projectId = 'p1'): NoteChangeEvent => ({ type: 'note.updated', noteId, projectId, rev, source: 'mcp' });

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue(page([OPENFLEET, OTHER])),
    listNotes: vi.fn((projectId: string) => Promise.resolve(page(summaries[projectId] ?? []))),
    getNote: vi.fn((_projectId: string, noteId: string) => Promise.resolve(views[noteId])),
    createNote: vi.fn(),
    listNoteVersions: vi.fn().mockResolvedValue(page([])),
    restoreNoteVersion: vi.fn(),
    ...overrides,
  };
}

async function renderView(api = fakeApi()) {
  const noteChanges = new Subject<NoteChangeEvent>();
  const reconnectCount = signal(0);
  await render(NotesViewComponent, {
    providers: [
      provideRouter([]),
      { provide: FleetApiService, useValue: api },
      { provide: FleetEventsService, useValue: { noteChanges, reconnectCount } },
      { provide: DirectoryOpener, useValue: { isAvailable: false, open: vi.fn() } },
      { provide: ActivatedRoute, useValue: { queryParamMap: new BehaviorSubject(convertToParamMap({})) } },
    ],
  });
  await screen.findByText('Original body');
  return { api, emit: (event: NoteChangeEvent) => noteChanges.next(event), reconnectCount };
}

const bodyOnScreen = () => screen.getByTestId('note-editor-body');
const notice = () => screen.queryByTestId('note-updated-notice');

describe('NotesViewComponent live refresh', () => {
  it('shows the refreshed body of the open note and tells the reader with a status message', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    api.getNote.mockResolvedValueOnce(refreshedN1());

    emit(updated('n1', 4));

    expect(await screen.findByText('Fresh body written by an agent')).toBeInTheDocument();
    const message = await screen.findByTestId('note-updated-notice');
    expect(message).toHaveAttribute('role', 'status');
    expect(message).toHaveTextContent('This note was updated');
  });

  it('keeps the old body on screen, with no loading skeleton, while the refreshed note is on its way', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    const refresh = deferred<NoteView>();
    api.getNote.mockReturnValueOnce(refresh.promise);

    emit(updated('n1', 4));
    await waitFor(() => expect(api.getNote).toHaveBeenCalledTimes(2));

    expect(bodyOnScreen()).toHaveTextContent('Original body');
    expect(screen.queryAllByTestId('note-skeleton-bar')).toHaveLength(0);
    refresh.resolve(refreshedN1());
    expect(await screen.findByText('Fresh body written by an agent')).toBeInTheDocument();
  });

  it('keeps the selection and the title of the open note while it refreshes', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    api.getNote.mockResolvedValueOnce(refreshedN1());

    emit(updated('n1', 4));
    await screen.findByText('Fresh body written by an agent');

    expect(screen.getByTestId('note-list-item-n1')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('note-editor-title')).toHaveTextContent('daemon-protocol');
  });

  it('shows the new revision in the list too', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    api.getNote.mockResolvedValueOnce(refreshedN1());
    api.listNotes.mockResolvedValueOnce(page([aNoteSummary({ id: 'n1', title: 'daemon-protocol renamed', rev: 4 }), summaries['p1']![1]!]));

    emit(updated('n1', 4));

    expect(await screen.findByText('daemon-protocol renamed')).toBeInTheDocument();
  });

  it('does not reload the open note for the echo of a revision it already shows, and shows no message', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);

    emit(updated('n1', 3));
    await waitFor(() => expect(api.listNotes).toHaveBeenCalledTimes(2));
    await nap(QUIET_PERIOD_PASSED_MS);

    expect(api.getNote).toHaveBeenCalledTimes(1);
    expect(notice()).not.toBeInTheDocument();
  });

  it('refreshes the list and shows nothing else for a note that is not open', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    api.listNotes.mockResolvedValueOnce(page([summaries['p1']![0]!, aNoteSummary({ id: 'n2', title: 'voice renamed', rev: 5 })]));

    emit(updated('n2', 5));

    expect(await screen.findByText('voice renamed')).toBeInTheDocument();
    expect(api.getNote).toHaveBeenCalledTimes(1);
    expect(bodyOnScreen()).toHaveTextContent('Original body');
    expect(notice()).not.toBeInTheDocument();
  });

  it('adds a note created elsewhere to the list', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    api.listNotes.mockResolvedValueOnce(page([...summaries['p1']!, aNoteSummary({ id: 'n3', title: 'brand-new-note' })]));

    emit({ type: 'note.created', noteId: 'n3', projectId: 'p1', rev: 1 });

    expect(await screen.findByText('brand-new-note')).toBeInTheDocument();
    expect(notice()).not.toBeInTheDocument();
  });

  it('ignores an event of a project that is not shown', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);

    emit(updated('n9', 2, 'p2'));
    await nap(QUIET_PERIOD_PASSED_MS);

    expect(api.listNotes).toHaveBeenCalledTimes(1);
    expect(api.getNote).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of ten events into one reload of the list and one reload of the note', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    api.getNote.mockResolvedValue(refreshedN1(13));

    for (let rev = 4; rev <= 13; rev++) emit(updated('n1', rev));
    await screen.findByText('Fresh body written by an agent');
    await nap(QUIET_PERIOD_PASSED_MS);

    expect(api.listNotes).toHaveBeenCalledTimes(2);
    expect(api.getNote).toHaveBeenCalledTimes(2);
  });

  it('does not show the refreshed note over another note the reader opened meanwhile', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    const refresh = deferred<NoteView>();
    api.getNote.mockReturnValueOnce(refresh.promise);
    emit(updated('n1', 4));
    await waitFor(() => expect(api.getNote).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await screen.findByText('Voice body');
    refresh.resolve(refreshedN1());
    await nap(100);

    expect(bodyOnScreen()).toHaveTextContent('Voice body');
    expect(screen.getByTestId('note-editor-title')).toHaveTextContent('voice');
    expect(notice()).not.toBeInTheDocument();
  });

  it('does not put the notes of the old project in the list of the project the reader switched to meanwhile', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    const staleList = deferred<ReturnType<typeof page<NoteSummary>>>();
    api.listNotes.mockReturnValueOnce(staleList.promise);
    emit(updated('n2', 2));
    await waitFor(() => expect(api.listNotes).toHaveBeenCalledTimes(2));

    await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p2');
    await screen.findByText('Other body');
    staleList.resolve(page(summaries['p1']!));
    await nap(100);

    expect(screen.getByTestId('note-list-item-n9')).toBeInTheDocument();
    expect(screen.queryByTestId('note-list-item-n1')).not.toBeInTheDocument();
    expect(bodyOnScreen()).toHaveTextContent('Other body');
  });

  it('removes the message when the reader opens another note', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    api.getNote.mockResolvedValueOnce(refreshedN1());
    emit(updated('n1', 4));
    await screen.findByTestId('note-updated-notice');

    await userEvent.click(screen.getByTestId('note-list-item-n2'));
    await screen.findByText('Voice body');

    expect(notice()).not.toBeInTheDocument();
  });

  it('keeps what the reader sees, with no error and no message, when the refresh fails', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    api.getNote.mockRejectedValueOnce(new ApiError(500, 'daemon down', 'internal'));

    emit(updated('n1', 4));
    await waitFor(() => expect(api.getNote).toHaveBeenCalledTimes(2));
    await nap(100);

    expect(bodyOnScreen()).toHaveTextContent('Original body');
    expect(screen.queryByTestId('note-error')).not.toBeInTheDocument();
    expect(notice()).not.toBeInTheDocument();
  });

  it('says the note cannot be opened any more when the open note was deleted', async () => {
    const api = fakeApi();
    const { emit } = await renderView(api);
    api.getNote.mockRejectedValueOnce(new ApiError(404, 'gone', 'note_not_found'));
    api.listNotes.mockResolvedValueOnce(page([summaries['p1']![1]!]));

    emit({ type: 'note.deleted', noteId: 'n1', projectId: 'p1' });

    expect(await screen.findByTestId('note-error')).toBeInTheDocument();
  });

  it('reloads the list and the open note when the connection to the daemon comes back', async () => {
    const api = fakeApi();
    const { reconnectCount } = await renderView(api);
    api.getNote.mockResolvedValueOnce(refreshedN1());

    reconnectCount.set(1);

    expect(await screen.findByText('Fresh body written by an agent')).toBeInTheDocument();
    expect(api.listNotes).toHaveBeenCalledTimes(2);
  });
});
