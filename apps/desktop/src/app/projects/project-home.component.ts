import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, Injector, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MANAGER_ROLE, type Project, type Session } from '@openfleet/shared';
import { map } from 'rxjs';
import { showInvisibleControlsAsEscapes } from '../core/bidi-escapes';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { StateChipComponent } from '../design/state-chip.component';
import { ProjectFormComponent } from './project-form.component';

type PageView = 'loading' | 'failed' | 'empty' | 'redirecting' | 'missing' | 'project';

type CountState = { status: 'loading' } | { status: 'ready'; total: number } | { status: 'failed' };

interface CountSource {
  readonly label: string;
  readonly read: (api: FleetApiService, projectId: string) => Promise<number>;
}

const LAST_VISITED_KEY = 'openfleet.project-home.last-visited';
const NO_DOCS_FOLDER = 'No docs folder';
const PROJECTS_LOAD_FAILED = "Couldn't load your projects.";

const COUNT_SOURCES: readonly CountSource[] = [
  { label: 'Notes', read: async (api, projectId) => (await api.listNotes(projectId, { limit: 1, offset: 0 })).total },
  { label: 'Tables', read: async (api, projectId) => (await api.listDataStores(projectId)).total },
  { label: 'Handoffs', read: async (api, projectId) => (await api.listHandoffs(projectId)).total },
];

const LOADING_COUNTS: readonly CountState[] = COUNT_SOURCES.map(() => ({ status: 'loading' }));

function readLastVisitedProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_VISITED_KEY);
  } catch {
    return null;
  }
}

function rememberLastVisitedProjectId(projectId: string): void {
  try {
    localStorage.setItem(LAST_VISITED_KEY, projectId);
  } catch {
    // The page works the same without a remembered project.
  }
}

/** The home of one project: its docs folder, what it holds, its managers and sessions, and the shortcuts into its notes and tables. */
@Component({
  selector: 'of-project-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, ProjectFormComponent, RouterLink, StateChipComponent],
  template: `
    <div class="home" data-testid="project-home">
      @switch (view()) {
        @case ('loading') {
          <p class="note" role="status">Loading projects…</p>
        }
        @case ('redirecting') {
          <p class="note" role="status">Opening your project…</p>
        }
        @case ('failed') {
          <div class="note">
            <of-error-line role="alert">${PROJECTS_LOAD_FAILED}</of-error-line>
            <button type="button" class="of-btn of-btn--secondary" (click)="loadProjects()">Retry</button>
          </div>
        }
        @case ('empty') {
          <h1>No projects yet</h1>
          <p class="note">Create one to keep handoffs and notes together.</p>
          @if (isCreatingProject()) {
            <div class="card">
              <of-project-form (saved)="openCreatedProject($event)" (cancelled)="isCreatingProject.set(false)" />
            </div>
          } @else {
            <div><button type="button" class="of-btn of-btn--primary" (click)="isCreatingProject.set(true)">Create a project</button></div>
          }
        }
        @case ('missing') {
          <h1>Project not found</h1>
          <of-error-line role="alert">This project no longer exists.</of-error-line>
          @if (projects().length > 0) {
            <a class="of-btn of-btn--secondary" routerLink="/project">Open another project</a>
          }
        }
        @case ('project') {
          @if (project(); as current) {
            <header class="header">
              <h1>{{ current.name }}</h1>
              @if (projects().length > 1) {
                <select class="of-input switcher" aria-label="Project" (change)="switchTo($event)">
                  @for (candidate of projects(); track candidate.id) {
                    <option [value]="candidate.id" [selected]="candidate.id === current.id">{{ candidate.name }}</option>
                  }
                </select>
              }
            </header>

            <nav class="actions" aria-label="Quick actions">
              <a class="of-btn of-btn--primary" routerLink="/new" [queryParams]="{ projectId: current.id }">New session in this project</a>
              <a class="of-btn of-btn--secondary" routerLink="/notes" [queryParams]="{ projectId: current.id }">Notes</a>
              <a class="of-btn of-btn--secondary" routerLink="/tables" [queryParams]="{ projectId: current.id }">Tables</a>
            </nav>

            <section class="card" aria-labelledby="overview-title">
              <h2 id="overview-title" class="card-title">Overview</h2>
              <dl class="counts">
                @for (source of countSources; track source.label; let index = $index) {
                  <div class="count">
                    <dt>{{ source.label }}</dt>
                    <dd>
                      @switch (counts()[index].status) {
                        @case ('ready') { <span class="total">{{ readyTotalOf(index) }}</span> }
                        @case ('failed') { <of-error-line>Couldn't load</of-error-line> }
                        @default { <span class="pending">…</span> }
                      }
                    </dd>
                  </div>
                }
              </dl>
            </section>

            <section class="card" aria-labelledby="docs-folder-title">
              <div class="card-head">
                <h2 id="docs-folder-title" class="card-title">Docs folder</h2>
                <span class="path" [attr.title]="current.docsFolderPath">{{ current.docsFolderPath ?? noDocsFolder }}</span>
                @if (!isEditingDocsFolder()) {
                  <button #changeButton type="button" class="of-btn of-btn--secondary of-btn--compact" (click)="isEditingDocsFolder.set(true)">Change…</button>
                }
              </div>
              @if (isEditingDocsFolder()) {
                <div class="card-body">
                  <of-project-form [project]="current" (saved)="finishEditingDocsFolder($event)" (cancelled)="closeDocsFolderEditor()" />
                </div>
              }
            </section>

            <section class="card" aria-labelledby="managers-title">
              <h2 id="managers-title" class="card-title">Managers</h2>
              @if (managers().length === 0) {
                <p class="note">No managers in this project yet</p>
              } @else {
                <ul class="rows">
                  @for (manager of managers(); track manager.id) {
                    <li><a class="row" [routerLink]="['/manager', manager.id]"><span class="name">{{ manager.emoji }} {{ visibleNameOf(manager) }}</span><of-state-chip [state]="manager.state" /></a></li>
                  }
                </ul>
              }
            </section>

            <section class="card" aria-labelledby="sessions-title">
              <h2 id="sessions-title" class="card-title">Sessions</h2>
              @if (workerSessions().length === 0) {
                <p class="note">No sessions in this project yet</p>
              } @else {
                <ul class="rows">
                  @for (session of workerSessions(); track session.id) {
                    <li><a class="row" [routerLink]="['/session', session.id]"><span class="name">{{ session.emoji }} {{ visibleNameOf(session) }}</span><of-state-chip [state]="session.state" /></a></li>
                  }
                </ul>
              }
            </section>
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; flex: 1; overflow: auto; }
    .home { display: flex; flex-direction: column; gap: 1rem; max-width: 56rem; padding: 1.25rem 1.5rem; }
    h1 { margin: 0; font-size: 1.125rem; font-weight: 600; }
    .header { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .switcher { width: auto; min-width: 10rem; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .note { margin: 0; font-size: .75rem; color: var(--mut); display: flex; align-items: center; gap: .5rem; }
    .card { border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .card-head { display: flex; align-items: center; gap: .5rem; padding: .625rem .875rem; }
    .card-title { margin: 0; flex: 1; font-size: .875rem; font-weight: 600; padding: .625rem .875rem 0; }
    .card-head .card-title { padding: 0; }
    .card > .note { padding: .5rem .875rem .75rem; }
    .card-body { padding: .75rem .875rem; border-top: 1px solid var(--line); }
    .path { min-width: 0; max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: .6875rem; color: var(--mut); }
    .counts { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0; padding: .625rem .875rem .875rem; }
    .count { flex: 1 1 8rem; display: flex; flex-direction: column; gap: .25rem; padding: .5rem .625rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--sunk); }
    .count dt { font-size: .6875rem; color: var(--mut); }
    .count dd { margin: 0; }
    .total { font-family: var(--mono); font-size: 1.25rem; font-weight: 500; color: var(--fg); }
    .pending { color: var(--mut); }
    .rows { list-style: none; margin: 0; padding: 0; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .4375rem .875rem; border-top: 1px solid var(--line); color: var(--fg); text-decoration: none; font-size: .75rem; }
    .row:hover { background: var(--hover); }
    .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  `,
})
export class ProjectHomeComponent {
  private readonly api = inject(FleetApiService);
  private readonly events = inject(FleetEventsService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly changeButton = viewChild<ElementRef<HTMLButtonElement>>('changeButton');
  private readonly requestedProjectId = toSignal(inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('id'))), { initialValue: null });

  protected readonly countSources = COUNT_SOURCES;
  protected readonly noDocsFolder = NO_DOCS_FOLDER;
  protected readonly projects = signal<readonly Project[]>([]);
  protected readonly counts = signal<readonly CountState[]>(LOADING_COUNTS);
  protected readonly isCreatingProject = signal(false);
  protected readonly isEditingDocsFolder = signal(false);
  private readonly loadStatus = signal<'loading' | 'ready' | 'failed'>('loading');

  protected readonly project = computed(() => this.projects().find((candidate) => candidate.id === this.requestedProjectId()));
  private readonly projectId = computed(() => this.project()?.id);

  protected readonly view = computed((): PageView => {
    const status = this.loadStatus();
    if (status !== 'ready') return status;
    if (this.projects().length === 0) return 'empty';
    if (this.requestedProjectId() === null) return 'redirecting';
    return this.project() ? 'project' : 'missing';
  });

  private readonly sessionsOfProject = computed(() => this.events.sessions().filter((session) => session.projectId === this.projectId()));
  protected readonly managers = computed(() => this.sessionsOfProject().filter((session) => session.role === MANAGER_ROLE));
  protected readonly workerSessions = computed(() => this.sessionsOfProject().filter((session) => session.role !== MANAGER_ROLE));

  constructor() {
    void this.loadProjects();
    effect(() => {
      const projectId = this.projectId();
      if (projectId === undefined) return;
      rememberLastVisitedProjectId(projectId);
      untracked(() => void this.loadCounts(projectId));
    });
  }

  protected async loadProjects(): Promise<void> {
    this.loadStatus.set('loading');
    try {
      const page = await this.api.listProjects();
      if (!Array.isArray(page?.items)) throw new Error('unreadable projects');
      this.projects.set(page.items);
      this.loadStatus.set('ready');
      this.openDefaultProjectWhenNoneRequested();
    } catch {
      this.loadStatus.set('failed');
    }
  }

  protected readyTotalOf(index: number): number {
    const count = this.counts()[index];
    return count?.status === 'ready' ? count.total : 0;
  }

  protected visibleNameOf(session: Session): string {
    return showInvisibleControlsAsEscapes(session.name);
  }

  protected switchTo(event: Event): void {
    const chosenProjectId = (event.target as HTMLSelectElement).value;
    void this.router.navigate(['/project', chosenProjectId]);
  }

  protected openCreatedProject(created: Project): void {
    this.projects.update((all) => [...all, created]);
    this.isCreatingProject.set(false);
    void this.router.navigate(['/project', created.id]);
  }

  protected finishEditingDocsFolder(saved: Project): void {
    this.projects.update((all) => all.map((candidate) => (candidate.id === saved.id ? saved : candidate)));
    this.closeDocsFolderEditor();
  }

  protected closeDocsFolderEditor(): void {
    this.isEditingDocsFolder.set(false);
    afterNextRender(() => this.changeButton()?.nativeElement.focus(), { injector: this.injector });
  }

  private openDefaultProjectWhenNoneRequested(): void {
    if (this.requestedProjectId() !== null) return;
    const all = this.projects();
    const lastVisited = all.find((candidate) => candidate.id === readLastVisitedProjectId());
    const target = lastVisited ?? all[0];
    if (target) void this.router.navigate(['/project', target.id], { replaceUrl: true });
  }

  private loadCounts(projectId: string): void {
    this.counts.set(LOADING_COUNTS);
    COUNT_SOURCES.forEach((source, index) => {
      const setCount = (count: CountState): void => {
        const isStillShown = this.projectId() === projectId;
        if (isStillShown) this.counts.update((all) => all.map((current, position) => (position === index ? count : current)));
      };
      source.read(this.api, projectId).then(
        (total) => setCount({ status: 'ready', total }),
        () => setCount({ status: 'failed' }),
      );
    });
  }
}
