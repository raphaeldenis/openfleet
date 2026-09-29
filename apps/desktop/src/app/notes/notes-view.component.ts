import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
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
import type { NoteSummary, NoteVersionSummary, NoteView, Project } from './notes.types';

type LoadStatus = 'loading' | 'ready' | 'error';

interface EditConflict {
  ours: string;
  theirs: ConflictingVersion;
  latest: NoteView;
}

const NEW_NOTE_TITLE = 'Untitled note';
const CONCURRENT_EDITOR = 'Another editor';
const MERGE_SEPARATOR = '\n\n';

const isStaleRevision = (error: unknown) => error instanceof ApiError && error.code === 'stale_revision';
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
        (selected)="openNote($event)"
        (create)="createNote()"
      />
    </aside>

    <section class="pane">
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
          (retry)="openNote(selectedId()!)"
          (openInFinder)="openSelectedFolder()"
        />
      } @else if (note(); as openNote) {
        @for (conflict of conflicts(); track conflict) {
          <of-note-conflict-banner [ours]="conflict.ours" [theirs]="conflict.theirs" (resolve)="resolveConflict($event)" />
        }
        <div class="doc-row">
          <of-note-editor [note]="openNote" [historyOpen]="historyOpen()" (historyToggle)="toggleHistory()" />
          @if (historyOpen()) {
            <of-note-history [versions]="versions()" (restore)="restoreVersion($event)" />
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
    .no-project { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .5rem; color: var(--mut) }
    .no-project-headline { color: var(--fg); font-weight: 500 }
  `,
})
export class NotesViewComponent {
  private readonly api = inject(FleetApiService);
  private readonly opener = inject(DirectoryOpener);
  private readonly queryParams = toSignal(inject(ActivatedRoute).queryParamMap);

  protected readonly projects = signal<readonly Project[]>([]);
  protected readonly projectsStatus = signal<LoadStatus>('loading');
  protected readonly projectsError = signal('');
  protected readonly projectId = signal<string | null>(null);

  protected readonly notes = signal<readonly NoteSummary[]>([]);
  protected readonly notesStatus = signal<LoadStatus>('loading');
  protected readonly notesError = signal('');
  protected readonly selectedId = signal<string | null>(null);

  protected readonly note = signal<NoteView | null>(null);
  protected readonly noteStatus = signal<LoadStatus>('loading');
  protected readonly noteError = signal('');

  protected readonly historyOpen = signal(false);
  protected readonly versions = signal<readonly NoteVersionSummary[]>([]);
  private readonly conflict = signal<EditConflict | null>(null);
  protected readonly conflicts = computed(() => {
    const conflict = this.conflict();
    return conflict ? [conflict] : [];
  });

  private readonly project = computed(() => this.projects().find((project) => project.id === this.projectId()));
  protected readonly projectName = computed(() => this.project()?.name ?? '');
  protected readonly selectedSummary = computed(() => this.notes().find((summary) => summary.id === this.selectedId()));

  protected readonly canOpenSelectedFolder = computed(() => {
    const isFileBacked = this.selectedSummary()?.fileBacked === true;
    const hasDocsFolder = !!this.project()?.docsFolderPath;
    return this.opener.isAvailable && isFileBacked && hasDocsFolder;
  });

  private latestNotesRequest = 0;
  private latestNoteRequest = 0;

  constructor() {
    void this.loadProjects();
  }

  async loadProjects(): Promise<void> {
    this.projectsStatus.set('loading');
    try {
      const { items } = await this.api.listProjects();
      const requestedProjectId = this.queryParams()?.get('projectId');
      const requestedProject = items.find((project) => project.id === requestedProjectId);
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
    void this.loadNotes();
  }

  protected async loadNotes(noteToOpenId?: string): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    const request = ++this.latestNotesRequest;
    this.notesStatus.set('loading');
    this.resetOpenNote();
    try {
      const { items } = await this.api.listNotes(projectId);
      if (request !== this.latestNotesRequest) return;
      this.notes.set(items);
      this.notesStatus.set('ready');
      const noteToOpen = noteToOpenId ?? items[0]?.id;
      if (noteToOpen) await this.openNote(noteToOpen);
    } catch (error) {
      if (request !== this.latestNotesRequest) return;
      this.notesError.set(reasonOf(error));
      this.notesStatus.set('error');
    }
  }

  protected async openNote(noteId: string): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    const request = ++this.latestNoteRequest;
    this.resetOpenNote();
    this.selectedId.set(noteId);
    this.noteStatus.set('loading');
    try {
      const openedNote = await this.api.getNote(projectId, noteId);
      if (request !== this.latestNoteRequest) return;
      this.note.set(openedNote);
      this.noteStatus.set('ready');
    } catch (error) {
      if (request !== this.latestNoteRequest) return;
      this.noteError.set(reasonOf(error));
      this.noteStatus.set('error');
    }
  }

  protected async createNote(): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    try {
      const createdNote = await this.api.createNote({ projectId, title: NEW_NOTE_TITLE, bodyMd: '' });
      await this.loadNotes(createdNote.id);
    } catch (error) {
      this.notesError.set(reasonOf(error));
      this.notesStatus.set('error');
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
    if (willOpen) await this.loadVersions();
  }

  protected async restoreVersion(rev: number): Promise<void> {
    const projectId = this.projectId();
    const openNote = this.note();
    if (projectId === null || openNote === null) return;
    try {
      this.note.set(await this.api.restoreNoteVersion(projectId, openNote.id, { rev, expectedRev: openNote.rev }));
      await this.loadVersions();
    } catch (error) {
      await this.handleWriteFailure(error);
    }
  }

  protected async resolveConflict(resolution: ConflictResolution): Promise<void> {
    const conflict = this.conflict();
    const projectId = this.projectId();
    if (conflict === null || projectId === null) return;
    this.conflict.set(null);

    if (resolution === 'theirs') {
      this.note.set(conflict.latest);
      await this.reloadVersionsWhenOpen();
      return;
    }

    const mergedBody = [conflict.ours, conflict.theirs.body].join(MERGE_SEPARATOR);
    const bodyMd = resolution === 'mine' ? conflict.ours : mergedBody;
    try {
      this.note.set(await this.api.updateNote(projectId, conflict.latest.id, { expectedRev: conflict.latest.rev, bodyMd }));
      await this.reloadVersionsWhenOpen();
    } catch (error) {
      await this.handleWriteFailure(error);
    }
  }

  private async handleWriteFailure(error: unknown): Promise<void> {
    const projectId = this.projectId();
    const openNote = this.note();
    if (!isStaleRevision(error) || projectId === null || openNote === null) {
      this.noteError.set(reasonOf(error));
      this.noteStatus.set('error');
      return;
    }
    const latest = await this.api.getNote(projectId, openNote.id);
    const theirs = { author: CONCURRENT_EDITOR, at: ageLabel(latest.updatedAt), body: latest.bodyMd };
    this.conflict.set({ ours: openNote.bodyMd, theirs, latest });
  }

  private async loadVersions(): Promise<void> {
    const projectId = this.projectId();
    const openNote = this.note();
    if (projectId === null || openNote === null) return;
    const { items } = await this.api.listNoteVersions(projectId, openNote.id);
    this.versions.set(items);
  }

  private async reloadVersionsWhenOpen(): Promise<void> {
    if (this.historyOpen()) await this.loadVersions();
  }

  private resetOpenNote(): void {
    this.note.set(null);
    this.conflict.set(null);
    this.historyOpen.set(false);
    this.versions.set([]);
  }
}
