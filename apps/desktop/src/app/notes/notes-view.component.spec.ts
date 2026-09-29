import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { DirectoryOpener } from './directory-opener';
import { NotesViewComponent } from './notes-view.component';
import { aNoteSummary, aNoteVersion, aNoteView } from './notes.fixtures';
import type { NoteSummary, NoteView, Project } from './notes.types';

const OPENFLEET: Project = { id: 'p1', name: 'OpenFleet', docsFolderPath: '/Users/me/docs' };
const OTHER: Project = { id: 'p2', name: 'Other', docsFolderPath: null };

const NOTE_SUMMARIES: Record<string, NoteSummary[]> = {
  p1: [aNoteSummary({ id: 'n1', title: 'daemon-protocol', rev: 3 }), aNoteSummary({ id: 'n2', title: 'voice' })],
  p2: [aNoteSummary({ id: 'n9', title: 'other-note' })],
};

const NOTE_VIEWS: Record<string, NoteView> = {
  n1: aNoteView({ id: 'n1', title: 'daemon-protocol', rev: 3, bodyMd: 'Original body' }),
  n2: aNoteView({ id: 'n2', title: 'voice', bodyMd: 'Voice body' }),
  n9: aNoteView({ id: 'n9', title: 'other-note', projectId: 'p2', bodyMd: 'Other body' }),
};

const page = <T>(items: T[]) => ({ items, total: items.length, limit: 100, offset: 0 });

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue(page([OPENFLEET, OTHER])),
    listNotes: vi.fn((projectId: string) => Promise.resolve(page(NOTE_SUMMARIES[projectId] ?? []))),
    getNote: vi.fn((_projectId: string, noteId: string) => Promise.resolve(NOTE_VIEWS[noteId])),
    createNote: vi.fn().mockResolvedValue(aNoteView({ id: 'new', title: 'Untitled note', bodyMd: '' })),
    updateNote: vi.fn().mockResolvedValue(aNoteView({ id: 'n1', rev: 6, bodyMd: 'updated' })),
    listNoteVersions: vi.fn().mockResolvedValue({ items: [aNoteVersion({ id: 'v1', rev: 1 }), aNoteVersion({ id: 'v2', rev: 2 })] }),
    restoreNoteVersion: vi.fn().mockResolvedValue(aNoteView({ id: 'n1', rev: 4, bodyMd: 'Restored body' })),
    ...overrides,
  };
}

function fakeOpener(isAvailable = true) {
  return { isAvailable, open: vi.fn().mockResolvedValue(undefined) };
}

async function renderView(options: { api?: ReturnType<typeof fakeApi>; opener?: ReturnType<typeof fakeOpener>; queryParams?: Record<string, string> } = {}) {
  const api = options.api ?? fakeApi();
  const opener = options.opener ?? fakeOpener();
  await render(NotesViewComponent, {
    providers: [
      provideRouter([]),
      { provide: FleetApiService, useValue: api },
      { provide: DirectoryOpener, useValue: opener },
      { provide: ActivatedRoute, useValue: { queryParamMap: new BehaviorSubject(convertToParamMap(options.queryParams ?? {})) } },
    ],
  });
  return { api, opener };
}

const editorTitle = () => screen.findByTestId('note-editor-title');

describe('NotesViewComponent', () => {
  describe('loading', () => {
    it('user sees skeleton bars while the project list is loading', async () => {
      await renderView({ api: fakeApi({ listProjects: vi.fn(() => new Promise(() => undefined)) }) });

      expect(screen.getAllByTestId('note-skeleton-bar')).toHaveLength(6);
    });
  });

  describe('projects', () => {
    it('user is told when there is no project yet', async () => {
      await renderView({ api: fakeApi({ listProjects: vi.fn().mockResolvedValue(page([])) }) });

      expect(await screen.findByTestId('notes-no-project')).toBeInTheDocument();
    });

    it('the first project is selected by default and its first note is open', async () => {
      const { api } = await renderView();

      expect(await editorTitle()).toHaveTextContent('daemon-protocol');
      expect(api.listNotes).toHaveBeenCalledWith('p1');
      expect(screen.getByTestId('notes-project-select')).toHaveValue('p1');
    });

    it('a projectId in the URL overrides the default project', async () => {
      const { api } = await renderView({ queryParams: { projectId: 'p2' } });

      expect(await editorTitle()).toHaveTextContent('other-note');
      expect(api.listNotes).toHaveBeenCalledWith('p2');
      expect(api.listNotes).not.toHaveBeenCalledWith('p1');
    });

    it('user can switch project and sees that project’s notes', async () => {
      await renderView();
      await editorTitle();

      await userEvent.selectOptions(screen.getByTestId('notes-project-select'), 'p2');

      expect(await screen.findByTestId('note-list-item-n9')).toBeInTheDocument();
      expect(screen.queryByTestId('note-list-item-n1')).not.toBeInTheDocument();
    });
  });

  describe('default', () => {
    it('user opens another note from the list', async () => {
      const { api } = await renderView();
      await editorTitle();

      await userEvent.click(screen.getByTestId('note-list-item-n2'));

      await waitFor(() => expect(screen.getByTestId('note-editor-title')).toHaveTextContent('voice'));
      expect(api.getNote).toHaveBeenCalledWith('p1', 'n2');
    });
  });

  describe('empty', () => {
    it('user creates the first note from the empty state', async () => {
      const createdSummary = aNoteSummary({ id: 'new', title: 'Untitled note' });
      const listNotes = vi.fn().mockResolvedValueOnce(page([])).mockResolvedValue(page([createdSummary]));
      const api = fakeApi({ listNotes, getNote: vi.fn().mockResolvedValue(aNoteView({ id: 'new', title: 'Untitled note', bodyMd: '' })) });
      await renderView({ api });

      await userEvent.click(await screen.findByTestId('note-empty-create'));

      expect(api.createNote).toHaveBeenCalledWith({ projectId: 'p1', title: 'Untitled note', bodyMd: '' });
      expect(await editorTitle()).toHaveTextContent('Untitled note');
    });

    it('user creates a note from the plus button of the list', async () => {
      const { api } = await renderView();
      await editorTitle();

      await userEvent.click(screen.getByTestId('note-list-new'));

      await waitFor(() => expect(api.createNote).toHaveBeenCalledOnce());
    });
  });

  describe('error', () => {
    it('user sees why a note could not be opened and can retry', async () => {
      const getNote = vi.fn().mockRejectedValueOnce(new ApiError(500, 'GET /api/notes/n1 → 500')).mockResolvedValue(NOTE_VIEWS['n1']);
      await renderView({ api: fakeApi({ getNote }) });

      expect(await screen.findByTestId('note-error-title')).toHaveTextContent('Couldn’t open “daemon-protocol”');

      await userEvent.click(screen.getByTestId('note-error-retry'));

      expect(await editorTitle()).toHaveTextContent('daemon-protocol');
      expect(getNote).toHaveBeenCalledTimes(2);
    });

    it('user can retry when the notes of a project could not be listed', async () => {
      const listNotes = vi.fn().mockRejectedValueOnce(new ApiError(0, 'daemon unreachable')).mockResolvedValue(page(NOTE_SUMMARIES['p1']));
      await renderView({ api: fakeApi({ listNotes }) });

      await userEvent.click(await screen.findByTestId('note-error-retry'));

      expect(await editorTitle()).toHaveTextContent('daemon-protocol');
    });
  });

  describe('open in Finder', () => {
    const failingFileBackedNote = () => {
      const summaries = [aNoteSummary({ id: 'n1', title: 'daemon-protocol', folder: 'specs', fileBacked: true })];
      return fakeApi({
        listNotes: vi.fn().mockResolvedValue(page(summaries)),
        getNote: vi.fn().mockRejectedValue(new ApiError(500, 'not valid UTF-8')),
      });
    };

    it('user opens the folder that holds the note file, not the file itself', async () => {
      const opener = fakeOpener();
      await renderView({ api: failingFileBackedNote(), opener });

      await userEvent.click(await screen.findByTestId('note-error-open-in-finder'));

      expect(opener.open).toHaveBeenCalledExactlyOnceWith('/Users/me/docs/specs');
    });

    it('the action is hidden when the project has no docs folder', async () => {
      await renderView({ api: failingFileBackedNote(), opener: fakeOpener(), queryParams: { projectId: 'p2' } });
      // the failing note belongs to the fake list of every project; project p2 has no docs folder

      await screen.findByTestId('note-error-retry');
      expect(screen.queryByTestId('note-error-open-in-finder')).not.toBeInTheDocument();
    });

    it('the action is hidden when the note is not backed by a file', async () => {
      const api = fakeApi({
        listNotes: vi.fn().mockResolvedValue(page([aNoteSummary({ id: 'n1', title: 'daemon-protocol', fileBacked: false })])),
        getNote: vi.fn().mockRejectedValue(new ApiError(500, 'boom')),
      });
      await renderView({ api });

      await screen.findByTestId('note-error-retry');
      expect(screen.queryByTestId('note-error-open-in-finder')).not.toBeInTheDocument();
    });

    it('the action is hidden when the app cannot open folders', async () => {
      await renderView({ api: failingFileBackedNote(), opener: fakeOpener(false) });

      await screen.findByTestId('note-error-retry');
      expect(screen.queryByTestId('note-error-open-in-finder')).not.toBeInTheDocument();
    });
  });

  describe('history', () => {
    it('user opens the history and restores a version onto the note', async () => {
      const { api } = await renderView();
      await editorTitle();

      await userEvent.click(screen.getByTestId('note-editor-history-toggle'));
      await userEvent.click(await screen.findByTestId('note-history-version-1'));
      await userEvent.click(screen.getByTestId('note-history-restore'));

      expect(api.listNoteVersions).toHaveBeenCalledWith('p1', 'n1');
      expect(api.restoreNoteVersion).toHaveBeenCalledWith('p1', 'n1', { rev: 1, expectedRev: 3 });
      await waitFor(() => expect(screen.getByTestId('note-editor-body')).toHaveTextContent('Restored body'));
    });

    it('user closes the history by clicking the toggle again', async () => {
      await renderView();
      await editorTitle();

      await userEvent.click(screen.getByTestId('note-editor-history-toggle'));
      await screen.findByTestId('note-history-restore');
      await userEvent.click(screen.getByTestId('note-editor-history-toggle'));

      expect(screen.queryByTestId('note-history-restore')).not.toBeInTheDocument();
    });
  });

  describe('conflict', () => {
    async function renderConflictOnRestore() {
      const latest = aNoteView({ id: 'n1', rev: 5, bodyMd: 'Body written by another editor' });
      const getNote = vi.fn((_projectId: string, noteId: string) => Promise.resolve(getNote.mock.calls.length > 1 ? latest : NOTE_VIEWS[noteId]));
      const restoreNoteVersion = vi.fn().mockRejectedValue(new ApiError(409, 'stale', 'stale_revision'));
      const api = fakeApi({ getNote, restoreNoteVersion });
      await renderView({ api });
      await editorTitle();
      await userEvent.click(screen.getByTestId('note-editor-history-toggle'));
      await userEvent.click(await screen.findByTestId('note-history-version-1'));
      await userEvent.click(screen.getByTestId('note-history-restore'));
      await screen.findByTestId('note-conflict-keep-mine');
      return { api };
    }

    it('user sees both versions when the note changed under them', async () => {
      await renderConflictOnRestore();

      expect(screen.getByTestId('note-conflict-ours')).toHaveTextContent('Original body');
      expect(screen.getByTestId('note-conflict-theirs')).toHaveTextContent('Body written by another editor');
    });

    it('user keeps their version on top of the latest revision', async () => {
      const { api } = await renderConflictOnRestore();

      await userEvent.click(screen.getByTestId('note-conflict-keep-mine'));

      await waitFor(() => expect(api.updateNote).toHaveBeenCalledExactlyOnceWith('p1', 'n1', { expectedRev: 5, bodyMd: 'Original body' }));
      await waitFor(() => expect(screen.queryByTestId('note-conflict-keep-mine')).not.toBeInTheDocument());
    });

    it('user takes the other version without writing anything', async () => {
      const { api } = await renderConflictOnRestore();

      await userEvent.click(screen.getByTestId('note-conflict-take-theirs'));

      await waitFor(() => expect(screen.getByTestId('note-editor-body')).toHaveTextContent('Body written by another editor'));
      expect(api.updateNote).not.toHaveBeenCalled();
      expect(screen.queryByTestId('note-conflict-keep-mine')).not.toBeInTheDocument();
    });

    it('user merges both versions into one write', async () => {
      const { api } = await renderConflictOnRestore();

      await userEvent.click(screen.getByTestId('note-conflict-merge'));

      await waitFor(() => expect(api.updateNote).toHaveBeenCalledExactlyOnceWith('p1', 'n1', {
        expectedRev: 5,
        bodyMd: 'Original body\n\nBody written by another editor',
      }));
    });
  });
});
