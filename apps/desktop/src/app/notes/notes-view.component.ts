import { ChangeDetectionStrategy, Component, Injector, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { ApiError, FleetApiService, type PageRequest } from '../core/fleet-api.service';
import { DirectoryOpener } from './directory-opener';
import { ageLabel } from './note-age';
import { NoteConflictBannerComponent, type ConflictingVersion, type ConflictResolution } from './note-conflict-banner.component';
import { NoteEditorComponent } from './note-editor.component';
import { NoteHistoryComponent } from './note-history.component';
import { NoteListComponent } from './note-list.component';
import { NoteStatePanelComponent } from './note-state-panel.component';
import type { NoteSummary, NoteVersionSummary, NoteView, Page, Project } from '@openfleet/shared';

type LoadStatus = 'loading' | 'ready' | 'error';

interface EditConflict {
  ours: string;
  theirs: ConflictingVersion;
  latest: NoteView;
  restoreRev: number;
}

interface ActionFailure {
  title: string;
  reason: string;
}

interface FailedWrite {
  ours: string;
  restoreRev: number;
}

interface WriteAttempt {
  write: () => Promise<NoteView>;
  failedWrite: FailedWrite;
}

type WriteOutcome = 'written' | 'conflicted' | 'failed' | 'abandoned';

const NEW_NOTE_TITLE = 'Untitled note';
const CONCURRENT_EDITOR = 'Another editor';
const PAGE_LIMIT = 200;
const RESTORE_FAILURE_TITLE = 'Couldn’t restore the version';

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
        [selectedId]="selectedId()"
        [hasLoaded]="notesStatus() === 'ready'"
        [canCreate]="canCreateNote()"
        [(filter)]="filter"
        (selected)="openNote($event)"
        (create)="createNote()"
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
              [currentRev]="openNote.rev"
              [isRestoreBlocked]="isRestoreBlocked()"
              [error]="versionsError()"
              (restore)="restoreVersion($event)"
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
  protected readonly versionsError = signal('');
  protected readonly isRestoring = signal(false);
  private readonly conflict = signal<EditConflict | null>(null);
  protected readonly isRestoreBlocked = computed(() => this.isRestoring() || this.conflict() !== null);
  protected readonly conflicts = computed(() => {
    const conflict = this.conflict();
    return conflict ? [conflict] : [];
  });

  private readonly requestedProjectId = computed(() => this.queryParams()?.get('projectId') ?? null);
  private readonly project = computed(() => this.projects().find((project) => project.id === this.projectId()));
  protected readonly projectName = computed(() => this.project()?.name ?? '');
  protected readonly selectedSummary = computed(() => this.notes().find((summary) => summary.id === this.selectedId()));

  // ponytail: POSIX absolute paths only until OPENER01 registers the opener plugin and its scope; validate against that scope then
  private readonly revealableDocsFolder = computed(() => {
    const docsFolderPath = this.project()?.docsFolderPath;
    return docsFolderPath?.startsWith('/') ? docsFolderPath : null;
  });

  protected readonly canOpenSelectedFolder = computed(() => {
    const isFileBacked = this.selectedSummary()?.fileBacked === true;
    const hasDocsFolder = this.revealableDocsFolder() !== null;
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
  private latestCreation = 0;

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
    this.latestCreation += 1;
    this.isCreating.set(false);
    void this.loadNotes();
  }

  protected async loadNotes(): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    const request = ++this.latestNotesRequest;
    this.notesStatus.set('loading');
    this.resetOpenNote();
    this.notes.set([]);
    this.selectedId.set(null);
    try {
      const allNotes = await fetchAllPages((page) => this.api.listNotes(projectId, page));
      if (request !== this.latestNotesRequest) return;
      this.notes.set(allNotes);
      this.notesStatus.set('ready');
      const firstNoteId = allNotes[0]?.id;
      if (firstNoteId) await this.openNote(firstNoteId);
    } catch (error) {
      if (request !== this.latestNotesRequest) return;
      this.notesError.set(reasonOf(error));
      this.notesStatus.set('error');
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
    const session = this.noteSession;
    const creation = ++this.latestCreation;
    const isSupersededByProjectSwitch = () => creation !== this.latestCreation;
    this.isCreating.set(true);
    this.actionFailure.set(null);
    try {
      const createdNote = await this.api.createNote({ projectId, title: NEW_NOTE_TITLE, bodyMd: '' });
      const projectChangedMeanwhile = this.projectId() !== projectId;
      if (projectChangedMeanwhile || isSupersededByProjectSwitch()) return;
      this.filter.set('');
      this.notes.update((notes) => [createdNote, ...notes.filter((summary) => summary.id !== createdNote.id)]);
      const userSelectedAnotherNoteMeanwhile = !this.isCurrentSession(session);
      if (userSelectedAnotherNoteMeanwhile) return;
      await this.openNote(createdNote.id, { focusEditor: true });
    } catch (error) {
      if (isSupersededByProjectSwitch()) return;
      this.actionFailure.set({ title: 'Couldn’t create the note', reason: reasonOf(error) });
    } finally {
      if (!isSupersededByProjectSwitch()) this.isCreating.set(false);
    }
  }

  protected openSelectedFolder(): void {
    const docsFolderPath = this.revealableDocsFolder();
    const folder = this.selectedSummary()?.folder;
    if (docsFolderPath === null) return;
    const noteFolderPath = folder ? `${docsFolderPath}/${folder}` : docsFolderPath;
    void this.opener.open(noteFolderPath);
  }

  protected async toggleHistory(): Promise<void> {
    const willOpen = !this.historyOpen();
    this.historyOpen.set(willOpen);
    if (willOpen) await this.loadVersions();
  }

  protected reloadVersions(): Promise<void> {
    return this.loadVersions();
  }

  protected async restoreVersion(rev: number): Promise<void> {
    const projectId = this.projectId();
    const openNote = this.note();
    if (projectId === null || openNote === null || this.isRestoreBlocked()) return;
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

    const isRestoreAnyway = resolution === 'restore';
    if (!isRestoreAnyway) {
      this.note.set(conflict.latest);
      this.focusEditorAfterRender();
      await this.reloadVersionsWhenOpen();
      return;
    }

    const { latest, restoreRev } = conflict;
    this.isRestoring.set(true);
    try {
      const outcome = await this.writeNote({
        session,
        write: () => this.api.restoreNoteVersion(projectId, latest.id, { rev: restoreRev, expectedRev: latest.rev }),
        failedWrite: { ours: conflict.ours, restoreRev },
      });
      const shouldOfferChoicesAgain = outcome === 'failed' && this.isCurrentSession(session);
      if (shouldOfferChoicesAgain) this.conflict.set(conflict);
    } finally {
      if (this.isCurrentSession(session)) this.isRestoring.set(false);
    }
  }

  private async writeNote({ session, write, failedWrite }: WriteAttempt & { session: number }): Promise<WriteOutcome> {
    this.actionFailure.set(null);
    try {
      const writtenNote = await write();
      if (!this.isCurrentSession(session)) return 'abandoned';
      this.note.set(writtenNote);
    } catch (error) {
      if (!this.isCurrentSession(session)) return 'abandoned';
      return this.handleWriteFailure({ error, session, failedWrite });
    }
    this.focusEditorAfterRender();
    await this.reloadVersionsWhenOpen();
    return 'written';
  }

  private async handleWriteFailure({ error, session, failedWrite }: { error: unknown; session: number } & Omit<WriteAttempt, 'write'>): Promise<WriteOutcome> {
    const projectId = this.projectId();
    const openNote = this.note();
    const isConcurrentEdit = isStaleRevision(error) && projectId !== null && openNote !== null;
    if (!isConcurrentEdit) {
      this.actionFailure.set({ title: RESTORE_FAILURE_TITLE, reason: reasonOf(error) });
      return 'failed';
    }
    try {
      const latest = await this.api.getNote(projectId, openNote.id);
      if (!this.isCurrentSession(session)) return 'abandoned';
      const { author, completeHistory } = await this.readLatestRevisionAuthor({ projectId, noteId: latest.id, rev: latest.rev });
      if (!this.isCurrentSession(session)) return 'abandoned';
      if (completeHistory !== null && this.historyOpen()) this.versions.set(completeHistory);
      const theirs = { author, at: ageLabel(latest.updatedAt), body: latest.bodyMd };
      this.conflict.set({ ours: failedWrite.ours, theirs, latest, restoreRev: failedWrite.restoreRev });
      return 'conflicted';
    } catch (lookupError) {
      if (!this.isCurrentSession(session)) return 'abandoned';
      this.showNoteError(lookupError);
      return 'failed';
    }
  }

  /** Versions are ordered oldest first, so the newest revision sits on the last page; `completeHistory` is set only when one page held the whole history. */
  private async readLatestRevisionAuthor({ projectId, noteId, rev }: { projectId: string; noteId: string; rev: number }): Promise<{ author: string; completeHistory: NoteVersionSummary[] | null }> {
    try {
      const firstPage = await this.api.listNoteVersions(projectId, noteId, { limit: PAGE_LIMIT, offset: 0 });
      const isWholeHistory = firstPage.total <= firstPage.items.length;
      const lastPage = isWholeHistory
        ? firstPage
        : await this.api.listNoteVersions(projectId, noteId, { limit: PAGE_LIMIT, offset: Math.max(0, firstPage.total - PAGE_LIMIT) });
      const author = lastPage.items.find((version) => version.rev === rev)?.author ?? CONCURRENT_EDITOR;
      return { author, completeHistory: isWholeHistory ? firstPage.items : null };
    } catch {
      return { author: CONCURRENT_EDITOR, completeHistory: null };
    }
  }

  // ponytail: one request per 200 revisions; add paging if a note ever reaches thousands of revisions
  private async loadVersions(): Promise<void> {
    const projectId = this.projectId();
    const openNote = this.note();
    if (projectId === null || openNote === null) return;
    const session = this.noteSession;
    const request = ++this.latestVersionsRequest;
    const isStale = () => !this.isCurrentSession(session) || request !== this.latestVersionsRequest;
    this.versionsError.set('');
    try {
      const allVersions = await fetchAllPages((page) => this.api.listNoteVersions(projectId, openNote.id, page));
      if (isStale()) return;
      this.versions.set(allVersions);
    } catch (error) {
      if (isStale()) return;
      this.versionsError.set(reasonOf(error));
    }
  }

  private async reloadVersionsWhenOpen(): Promise<void> {
    if (this.historyOpen()) await this.loadVersions();
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
    this.versionsError.set('');
    this.actionFailure.set(null);
    this.isRestoring.set(false);
    return ++this.noteSession;
  }
}
