import { ChangeDetectionStrategy, Component, Injector, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { DirectoryOpener } from './directory-opener';
import { ageLabel } from './note-age';
import { NoteConflictBannerComponent, type ConflictingVersion, type ConflictResolution } from './note-conflict-banner.component';
import { NoteEditorComponent } from './note-editor.component';
import { NoteHistoryComponent } from './note-history.component';
import { NoteListComponent } from './note-list.component';
import { NoteStatePanelComponent } from './note-state-panel.component';
import type { NoteSummary, NoteVersionSummary, NoteView, Page, PageRequest, Project } from './notes.types';

type LoadStatus = 'loading' | 'ready' | 'error';

interface EditConflict {
  ours: string;
  theirs: ConflictingVersion;
  latest: NoteView;
  restoreRev: number | null;
}

interface ActionFailure {
  title: string;
  reason: string;
}

interface FailedWrite {
  ours: string;
  restoreRev: number | null;
}

const NEW_NOTE_TITLE = 'Untitled note';
const CONCURRENT_EDITOR = 'Another editor';
const MERGE_SEPARATOR = '\n\n';
const PAGE_LIMIT = 200;

const isStaleRevision = (error: unknown) => error instanceof ApiError && error.code === 'stale_revision';
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function fetchAllPages<T>(fetchPage: (request: PageRequest) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let isLastPage = false;
  do {
    const page = await fetchPage({ limit: PAGE_LIMIT, offset: items.length });
    items.push(...page.items);
    isLastPage = page.items.length === 0 || items.length >= page.total;
  } while (!isLastPage);
  return items;
}

@Component({
  selector: 'of-notes-view',
  imports: [NoteListComponent, NoteEditorComponent, NoteHistoryComponent, NoteConflictBannerComponent, NoteStatePanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'notes-view' },
  template: `
    <aside class="sidebar">
      <select class="project-select" aria-label="Project" data-testid="notes-project-select" (change)="switchProject($any($event.target).value)">
        @for (project of projects(); track project.id) {
          <option [value]="project.id" [selected]="project.id === projectId()">{{ project.name }}</option>
        }
      </select>
      <of-note-list
        [notes]="notes()"
        [total]="notesTotal()"
        [selectedId]="selectedId()"
        [hasLoaded]="notesStatus() === 'ready'"
        [canCreate]="canCreateNote()"
        [(filter)]="filter"
        (selected)="openNote($event)"
        (create)="createNote()"
        (loadMore)="loadMoreNotes()"
      />
    </aside>

    <section class="pane">
      @if (actionFailure(); as failure) {
        <div class="action-failure" role="alert" data-testid="note-action-error">
          <span class="action-failure-title" data-testid="note-action-error-title">✕ {{ failure.title }}</span>
          <span class="action-failure-reason" data-testid="note-action-error-reason">{{ failure.reason }}</span>
          <button type="button" class="of-btn of-btn--secondary" data-testid="note-action-error-dismiss" (click)="actionFailure.set(null)">Dismiss</button>
        </div>
      }
      @if (projectsStatus() === 'loading') {
        <of-note-state-panel state="loading" />
      } @else if (projectsStatus() === 'error') {
        <of-note-state-panel state="error" title="projects" [reason]="projectsError()" [canOpenInFinder]="false" (retry)="loadProjects()" />
      } @else if (projects().length === 0) {
        <div class="no-project" data-testid="notes-no-project">
          <span class="no-project-headline">No project yet</span>
          <span>Create a project first: notes belong to a project.</span>
        </div>
      } @else if (notesStatus() === 'loading') {
        <of-note-state-panel state="loading" />
      } @else if (notesStatus() === 'error') {
        <of-note-state-panel state="error" [title]="projectName()" [reason]="notesError()" [canOpenInFinder]="false" (retry)="loadNotes()" />
      } @else if (notes().length === 0) {
        <of-note-state-panel state="empty" (create)="createNote()" />
      } @else if (noteStatus() === 'loading') {
        <of-note-state-panel state="loading" />
      } @else if (noteStatus() === 'error') {
        <of-note-state-panel
          state="error"
          [title]="selectedSummary()?.title ?? ''"
          [reason]="noteError()"
          [canOpenInFinder]="canOpenSelectedFolder()"
          (retry)="retryOpenNote()"
          (openInFinder)="openSelectedFolder()"
        />
      } @else if (note(); as openNote) {
        @for (conflict of conflicts(); track conflict) {
          <of-note-conflict-banner [ours]="conflict.ours" [theirs]="conflict.theirs" [restoreRev]="conflict.restoreRev" (resolve)="resolveConflict($event)" />
        }
        <div class="doc-row">
          <of-note-editor [note]="openNote" [historyOpen]="historyOpen()" (historyToggle)="toggleHistory()" />
          @if (historyOpen()) {
            <of-note-history
              [versions]="versions()"
              [total]="versionsTotal()"
              [currentRev]="openNote.rev"
              [isRestoring]="isRestoring()"
              [error]="versionsError()"
              (restore)="restoreVersion($event)"
              (loadMore)="loadMoreVersions()"
              (retry)="reloadVersions()"
            />
          }
        </div>
      }
    </section>
  `,
  styles: `
    :host { display: flex; flex: 1; min-width: 0; min-height: 0; background: var(--bg) }
    .sidebar { display: flex; flex-direction: column; width: 15rem; flex: none; min-height: 0; border-right: 1px solid var(--line); background: var(--panel) }
    .sidebar of-note-list { flex: 1; min-height: 0; border-right: 0 }
    .project-select {
      margin: .625rem .75rem 0; height: 1.625rem; padding: 0 .5rem; border: 1px solid var(--line); border-radius: .375rem;
      background: var(--sunk); color: var(--fg); font: inherit; font-size: .75rem;
    }
    .project-select:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column }
    .doc-row { flex: 1; min-height: 0; display: flex }
    .action-failure { flex: none; display: flex; align-items: center; gap: .75rem; padding: .5rem 1.25rem; border-bottom: 1px solid var(--line); font-size: .75rem }
    .action-failure-title { color: var(--state-error); font-weight: 600 }
    .action-failure-reason { flex: 1; color: var(--mut) }
    .no-project { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .5rem; color: var(--mut) }
    .no-project-headline { color: var(--fg); font-weight: 500 }
  `,
})
export class NotesViewComponent {
  private readonly api = inject(FleetApiService);
  private readonly opener = inject(DirectoryOpener);
  private readonly injector = inject(Injector);
  private readonly queryParams = toSignal(inject(ActivatedRoute).queryParamMap);
  private readonly editor = viewChild(NoteEditorComponent);

  protected readonly projects = signal<readonly Project[]>([]);
  protected readonly projectsStatus = signal<LoadStatus>('loading');
  protected readonly projectsError = signal('');
  protected readonly projectId = signal<string | null>(null);

  protected readonly notes = signal<readonly NoteSummary[]>([]);
  protected readonly notesTotal = signal(0);
  protected readonly notesStatus = signal<LoadStatus>('loading');
  protected readonly notesError = signal('');
  protected readonly selectedId = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly isCreating = signal(false);
  protected readonly actionFailure = signal<ActionFailure | null>(null);

  protected readonly note = signal<NoteView | null>(null);
  protected readonly noteStatus = signal<LoadStatus>('loading');
  protected readonly noteError = signal('');

  protected readonly historyOpen = signal(false);
  protected readonly versions = signal<readonly NoteVersionSummary[]>([]);
  protected readonly versionsTotal = signal(0);
  protected readonly versionsError = signal('');
  protected readonly isRestoring = signal(false);
  private readonly conflict = signal<EditConflict | null>(null);
  protected readonly conflicts = computed(() => {
    const conflict = this.conflict();
    return conflict ? [conflict] : [];
  });

  private readonly requestedProjectId = computed(() => this.queryParams()?.get('projectId') ?? null);
  private readonly project = computed(() => this.projects().find((project) => project.id === this.projectId()));
  protected readonly projectName = computed(() => this.project()?.name ?? '');
  protected readonly selectedSummary = computed(() => this.notes().find((summary) => summary.id === this.selectedId()));

  protected readonly canOpenSelectedFolder = computed(() => {
    const isFileBacked = this.selectedSummary()?.fileBacked === true;
    const hasDocsFolder = !!this.project()?.docsFolderPath;
    return this.opener.isAvailable && isFileBacked && hasDocsFolder;
  });

  protected readonly canCreateNote = computed(() => {
    const hasProject = this.projectId() !== null;
    const isNoteListReady = this.notesStatus() === 'ready';
    return hasProject && isNoteListReady && !this.isCreating();
  });

  private latestNotesRequest = 0;
  private latestVersionsRequest = 0;
  private noteSession = 0;
  private isLoadingMoreNotes = false;
  private oldestLoadedVersionOffset = 0;

  constructor() {
    void this.loadProjects();
    effect(() => {
      const requestedProjectId = this.requestedProjectId();
      untracked(() => this.switchToRequestedProject(requestedProjectId));
    });
  }

  async loadProjects(): Promise<void> {
    this.projectsStatus.set('loading');
    try {
      const items = await fetchAllPages((request) => this.api.listProjects(request));
      const requestedProject = items.find((project) => project.id === this.requestedProjectId());
      this.projects.set(items);
      this.projectId.set((requestedProject ?? items[0])?.id ?? null);
      this.projectsStatus.set('ready');
    } catch (error) {
      this.projectsError.set(reasonOf(error));
      this.projectsStatus.set('error');
      return;
    }
    await this.loadNotes();
  }

  protected switchProject(projectId: string): void {
    this.projectId.set(projectId);
    this.filter.set('');
    void this.loadNotes();
  }

  protected async loadNotes(): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    const request = ++this.latestNotesRequest;
    this.notesStatus.set('loading');
    this.resetOpenNote();
    this.notes.set([]);
    this.notesTotal.set(0);
    this.selectedId.set(null);
    this.actionFailure.set(null);
    try {
      const page = await this.api.listNotes(projectId, { limit: PAGE_LIMIT });
      if (request !== this.latestNotesRequest) return;
      this.notes.set(page.items);
      this.notesTotal.set(page.total);
      this.notesStatus.set('ready');
      const firstNoteId = page.items[0]?.id;
      if (firstNoteId) await this.openNote(firstNoteId);
    } catch (error) {
      if (request !== this.latestNotesRequest) return;
      this.notesError.set(reasonOf(error));
      this.notesStatus.set('error');
    }
  }

  protected async loadMoreNotes(): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null || this.isLoadingMoreNotes) return;
    const request = this.latestNotesRequest;
    this.isLoadingMoreNotes = true;
    try {
      const alreadyLoadedCount = this.notes().length;
      const page = await this.api.listNotes(projectId, { limit: PAGE_LIMIT, offset: alreadyLoadedCount });
      if (request !== this.latestNotesRequest) return;
      const knownIds = new Set(this.notes().map((summary) => summary.id));
      this.notes.update((notes) => [...notes, ...page.items.filter((summary) => !knownIds.has(summary.id))]);
      this.notesTotal.set(page.total);
    } catch (error) {
      if (request !== this.latestNotesRequest) return;
      this.actionFailure.set({ title: 'Couldn’t load more notes', reason: reasonOf(error) });
    } finally {
      this.isLoadingMoreNotes = false;
    }
  }

  protected async openNote(noteId: string, { focusEditor = false } = {}): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    const isAlreadyOpenOrOpening = noteId === this.selectedId() && this.noteStatus() !== 'error';
    if (isAlreadyOpenOrOpening) return;
    const session = this.resetOpenNote();
    this.selectedId.set(noteId);
    this.noteStatus.set('loading');
    try {
      const openedNote = await this.api.getNote(projectId, noteId);
      if (!this.isCurrentSession(session)) return;
      this.note.set(openedNote);
      this.noteStatus.set('ready');
      if (focusEditor) this.focusEditorAfterRender();
    } catch (error) {
      if (!this.isCurrentSession(session)) return;
      this.showNoteError(error);
    }
  }

  protected retryOpenNote(): Promise<void> {
    const selectedId = this.selectedId();
    return selectedId === null ? Promise.resolve() : this.openNote(selectedId, { focusEditor: true });
  }

  protected async createNote(): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null || this.isCreating()) return;
    this.isCreating.set(true);
    this.actionFailure.set(null);
    try {
      const createdNote = await this.api.createNote({ projectId, title: NEW_NOTE_TITLE, bodyMd: '' });
      const projectChangedMeanwhile = this.projectId() !== projectId;
      if (projectChangedMeanwhile) return;
      this.filter.set('');
      this.notes.update((notes) => [createdNote, ...notes]);
      this.notesTotal.update((total) => total + 1);
      await this.openNote(createdNote.id);
    } catch (error) {
      this.actionFailure.set({ title: 'Couldn’t create the note', reason: reasonOf(error) });
    } finally {
      this.isCreating.set(false);
    }
  }

  protected openSelectedFolder(): void {
    const docsFolderPath = this.project()?.docsFolderPath;
    const folder = this.selectedSummary()?.folder;
    if (!docsFolderPath) return;
    const noteFolderPath = folder ? `${docsFolderPath}/${folder}` : docsFolderPath;
    void this.opener.open(noteFolderPath);
  }

  protected async toggleHistory(): Promise<void> {
    const willOpen = !this.historyOpen();
    this.historyOpen.set(willOpen);
    if (willOpen) await this.loadVersions({ session: this.noteSession, mode: 'newest' });
  }

  protected reloadVersions(): Promise<void> {
    return this.loadVersions({ session: this.noteSession, mode: 'newest' });
  }

  protected loadMoreVersions(): Promise<void> {
    return this.loadVersions({ session: this.noteSession, mode: 'older' });
  }

  protected async restoreVersion(rev: number): Promise<void> {
    const projectId = this.projectId();
    const openNote = this.note();
    if (projectId === null || openNote === null || this.isRestoring()) return;
    const session = this.noteSession;
    this.isRestoring.set(true);
    try {
      await this.writeNote({
        session,
        write: () => this.api.restoreNoteVersion(projectId, openNote.id, { rev, expectedRev: openNote.rev }),
        failedWrite: { ours: openNote.bodyMd, restoreRev: rev },
      });
    } finally {
      if (this.isCurrentSession(session)) this.isRestoring.set(false);
    }
  }

  protected async resolveConflict(resolution: ConflictResolution): Promise<void> {
    const conflict = this.conflict();
    const projectId = this.projectId();
    if (conflict === null || projectId === null) return;
    const session = this.noteSession;
    this.conflict.set(null);
    const { latest } = conflict;

    if (resolution === 'theirs') {
      this.note.set(latest);
      this.focusEditorAfterRender();
      await this.reloadVersionsWhenOpen(session);
      return;
    }

    if (resolution === 'restore' && conflict.restoreRev !== null) {
      const rev = conflict.restoreRev;
      await this.writeNote({
        session,
        write: () => this.api.restoreNoteVersion(projectId, latest.id, { rev, expectedRev: latest.rev }),
        failedWrite: { ours: conflict.ours, restoreRev: rev },
      });
      return;
    }

    const mergedBody = [conflict.ours, conflict.theirs.body].join(MERGE_SEPARATOR);
    const bodyMd = resolution === 'merge' ? mergedBody : conflict.ours;
    await this.writeNote({
      session,
      write: () => this.api.updateNote(projectId, latest.id, { expectedRev: latest.rev, bodyMd }),
      failedWrite: { ours: bodyMd, restoreRev: null },
    });
  }

  private async writeNote({ session, write, failedWrite }: { session: number; write: () => Promise<NoteView>; failedWrite: FailedWrite }): Promise<void> {
    try {
      const writtenNote = await write();
      if (!this.isCurrentSession(session)) return;
      this.note.set(writtenNote);
    } catch (error) {
      if (!this.isCurrentSession(session)) return;
      await this.handleWriteFailure({ error, session, failedWrite });
      return;
    }
    this.focusEditorAfterRender();
    await this.reloadVersionsWhenOpen(session);
  }

  private async handleWriteFailure({ error, session, failedWrite }: { error: unknown; session: number; failedWrite: FailedWrite }): Promise<void> {
    const projectId = this.projectId();
    const openNote = this.note();
    if (!isStaleRevision(error) || projectId === null || openNote === null) {
      this.showNoteError(error);
      return;
    }
    try {
      const latest = await this.api.getNote(projectId, openNote.id);
      if (!this.isCurrentSession(session)) return;
      const theirs = { author: CONCURRENT_EDITOR, at: ageLabel(latest.updatedAt), body: latest.bodyMd };
      this.conflict.set({ ours: failedWrite.ours, theirs, latest, restoreRev: failedWrite.restoreRev });
    } catch (lookupError) {
      if (!this.isCurrentSession(session)) return;
      this.showNoteError(lookupError);
    }
  }

  // The daemon lists versions oldest first: the newest page is the last one, older pages are prepended.
  private async loadVersions({ session, mode }: { session: number; mode: 'newest' | 'older' }): Promise<void> {
    const projectId = this.projectId();
    const openNote = this.note();
    if (projectId === null || openNote === null) return;
    const request = ++this.latestVersionsRequest;
    const isStale = () => !this.isCurrentSession(session) || request !== this.latestVersionsRequest;
    const fetchVersions = (page: PageRequest) => this.api.listNoteVersions(projectId, openNote.id, page);
    this.versionsError.set('');
    try {
      if (mode === 'older') {
        const oldestLoadedOffset = this.oldestLoadedVersionOffset;
        if (oldestLoadedOffset === 0) return;
        const offset = Math.max(0, oldestLoadedOffset - PAGE_LIMIT);
        const olderPage = await fetchVersions({ limit: oldestLoadedOffset - offset, offset });
        if (isStale()) return;
        this.versions.update((versions) => [...olderPage.items, ...versions]);
        this.versionsTotal.set(olderPage.total);
        this.oldestLoadedVersionOffset = offset;
        return;
      }
      const firstPage = await fetchVersions({ limit: PAGE_LIMIT, offset: 0 });
      if (isStale()) return;
      const lastPageOffset = Math.max(0, firstPage.total - PAGE_LIMIT);
      const newestPage = lastPageOffset === 0 ? firstPage : await fetchVersions({ limit: PAGE_LIMIT, offset: lastPageOffset });
      if (isStale()) return;
      this.versions.set(newestPage.items);
      this.versionsTotal.set(newestPage.total);
      this.oldestLoadedVersionOffset = lastPageOffset;
    } catch (error) {
      if (!this.isCurrentSession(session) || request !== this.latestVersionsRequest) return;
      this.versionsError.set(reasonOf(error));
    }
  }

  private async reloadVersionsWhenOpen(session: number): Promise<void> {
    if (this.historyOpen()) await this.loadVersions({ session, mode: 'newest' });
  }

  private showNoteError(error: unknown): void {
    this.noteError.set(reasonOf(error));
    this.noteStatus.set('error');
  }

  private switchToRequestedProject(requestedProjectId: string | null): void {
    const isKnownProject = this.projects().some((project) => project.id === requestedProjectId);
    const isAlreadyCurrent = requestedProjectId === this.projectId();
    if (requestedProjectId === null || !isKnownProject || isAlreadyCurrent) return;
    this.switchProject(requestedProjectId);
  }

  private focusEditorAfterRender(): void {
    afterNextRender(() => this.editor()?.focus(), { injector: this.injector });
  }

  private isCurrentSession(session: number): boolean {
    return session === this.noteSession;
  }

  private resetOpenNote(): number {
    this.note.set(null);
    this.conflict.set(null);
    this.historyOpen.set(false);
    this.versions.set([]);
    this.versionsTotal.set(0);
    this.versionsError.set('');
    this.isRestoring.set(false);
    return ++this.noteSession;
  }
}
