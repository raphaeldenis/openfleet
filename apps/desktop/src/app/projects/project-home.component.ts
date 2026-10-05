import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, Injector, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MANAGER_ROLE, type Project, type Session } from '@openfleet/shared';
import { map } from 'rxjs';
import { showInvisibleControlsAsEscapes } from '../core/bidi-escapes';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { compactElapsedLabel } from '../design/elapsed-time';
import { ErrorLineComponent } from '../design/error-line.component';
import { moveFocusWithinListbox } from '../design/listbox-keyboard';
import { PopoverComponent } from '../design/popover.component';
import { StateChipComponent } from '../design/state-chip.component';
import { ProjectFormComponent } from './project-form.component';

type PageView = 'loading' | 'failed' | 'empty' | 'redirecting' | 'missing' | 'project';

type CountState = { status: 'loading' } | { status: 'ready'; total: number } | { status: 'failed' };

interface CountSource {
  readonly label: string;
  readonly route: string;
  readonly read: (api: FleetApiService, projectId: string) => Promise<number>;
}

const LAST_VISITED_KEY = 'openfleet.project-home.last-visited';
const NO_DOCS_FOLDER = 'No docs folder';
const PROJECTS_LOAD_FAILED = "Couldn't load your projects.";

const COUNT_SOURCES: readonly CountSource[] = [
  { label: 'Notes', route: '/notes', read: async (api, projectId) => (await api.listNotes(projectId, { limit: 1, offset: 0 })).total },
  { label: 'Tables', route: '/tables', read: async (api, projectId) => (await api.listDataStores(projectId)).total },
  { label: 'Handoffs', route: '/notes', read: async (api, projectId) => (await api.listHandoffs(projectId)).total },
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
  imports: [ErrorLineComponent, PopoverComponent, ProjectFormComponent, RouterLink, StateChipComponent],
  template: `
    <div class="home" data-testid="project-home">
      @switch (view()) {
        @case ('loading') {
          <div class="skeleton" role="status" aria-label="Loading projects">
            <span class="skeleton-block skeleton-title"></span>
            <div class="skeleton-tiles"><span class="skeleton-block skeleton-tile"></span><span class="skeleton-block skeleton-tile"></span><span class="skeleton-block skeleton-tile"></span></div>
            <span class="skeleton-block skeleton-card"></span>
          </div>
        }
        @case ('redirecting') {
          <p class="note" role="status">Opening your project…</p>
        }
        @case ('failed') {
          <div class="centred">
            <of-error-line role="alert">${PROJECTS_LOAD_FAILED}</of-error-line>
            <button type="button" class="of-btn of-btn--secondary" (click)="loadProjects()">Retry</button>
          </div>
        }
        @case ('empty') {
          <div class="centred">
            <h1>No projects yet</h1>
            <p class="note">Create one to keep handoffs and notes together.</p>
            @if (isCreatingProject()) {
              <div class="card creation">
                <of-project-form (saved)="openCreatedProject($event)" (cancelled)="isCreatingProject.set(false)" />
              </div>
            } @else {
              <button type="button" class="of-btn of-btn--primary" (click)="isCreatingProject.set(true)">Create a project</button>
            }
          </div>
        }
        @case ('missing') {
          <div class="centred">
            <h1>Project not found</h1>
            <of-error-line role="alert">This project no longer exists.</of-error-line>
            @if (firstProject(); as first) {
              <a class="of-btn of-btn--secondary" [routerLink]="['/project', first.id]">Open {{ first.name }}</a>
            }
          </div>
        }
        @case ('project') {
          @if (project(); as current) {
            <header class="header">
              <h1>{{ current.name }}</h1>
              @if (projects().length > 1) {
                <of-popover #switcher triggerTestId="project-switcher" triggerLabel="Switch project" width="12rem">
                  <span popoverTrigger class="switcher-current"><span class="switcher-prefix">Project</span> {{ current.name }}</span>
                  <ng-template>
                    <div role="listbox" aria-label="Projects" #listbox (keydown)="moveFocusWithinListbox($event, listbox)">
                      @for (candidate of projects(); track candidate.id) {
                        <button
                          type="button"
                          role="option"
                          class="project-option"
                          [attr.aria-selected]="candidate.id === current.id"
                          [attr.tabindex]="candidate.id === current.id ? 0 : -1"
                          [attr.data-initial-focus]="candidate.id === current.id ? '' : null"
                          (click)="switchTo({ projectId: candidate.id, popover: switcher })"
                        >
                          <span class="check" aria-hidden="true">{{ candidate.id === current.id ? '✓' : '' }}</span>
                          <span class="project-option-name">{{ candidate.name }}</span>
                        </button>
                      }
                    </div>
                  </ng-template>
                </of-popover>
              }
            </header>

            <div class="tiles" role="group" aria-label="Counts">
              @for (source of countSources; track source.label; let index = $index) {
                <a class="tile" [routerLink]="source.route" [queryParams]="{ projectId: current.id }">
                  <span class="tile-label">{{ source.label }}</span>
                  @switch (counts()[index].status) {
                    @case ('ready') { <span class="total">{{ readyTotalOf(index) }}</span> }
                    @case ('failed') { <of-error-line>Couldn't load</of-error-line> }
                    @default { <span class="pending">…</span> }
                  }
                </a>
              }
            </div>

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

            <div class="lists">
              <section class="card list" aria-labelledby="managers-title">
                <div class="list-head">
                  <h2 id="managers-title" class="card-title">Managers</h2>
                  <span class="list-count" data-testid="list-count">{{ managers().length }}</span>
                </div>
                @if (managers().length === 0) {
                  <p class="note">No managers in this project.</p>
                } @else {
                  <ul class="rows">
                    @for (manager of managers(); track manager.id) {
                      <li>
                        <a class="row" [routerLink]="['/manager', manager.id]">
                          <span class="emoji-tile" aria-hidden="true">{{ manager.emoji }}</span>
                          <span class="name">{{ visibleNameOf(manager) }}</span>
                          <of-state-chip [state]="manager.state" />
                          <span class="meta" data-testid="manager-row-meta">{{ managerMetaOf(manager) }}</span>
                        </a>
                      </li>
                    }
                  </ul>
                }
              </section>

              <section class="card list" aria-labelledby="sessions-title">
                <div class="list-head">
                  <h2 id="sessions-title" class="card-title">Sessions</h2>
                  <span class="list-count" data-testid="list-count">{{ workerSessions().length }}</span>
                </div>
                @if (workerSessions().length === 0) {
                  <p class="note">No sessions in this project.</p>
                } @else {
                  <ul class="rows">
                    @for (session of workerSessions(); track session.id) {
                      <li>
                        <a class="row" [routerLink]="['/session', session.id]">
                          <span class="emoji-tile" aria-hidden="true">{{ session.emoji }}</span>
                          <span class="name">{{ visibleNameOf(session) }}</span>
                          <of-state-chip [state]="session.state" />
                          <span class="meta">{{ session.model }}</span>
                        </a>
                      </li>
                    }
                  </ul>
                }
              </section>
            </div>

            <nav class="actions" aria-label="Quick actions">
              <a class="of-btn of-btn--primary" routerLink="/new" [queryParams]="{ projectId: current.id }">New session</a>
              <a class="of-btn of-btn--secondary" routerLink="/notes" [queryParams]="{ projectId: current.id }">Notes</a>
              <a class="of-btn of-btn--secondary" routerLink="/tables" [queryParams]="{ projectId: current.id }">Tables</a>
              <span class="actions-hint">New session preselects {{ current.name }} · Notes and Tables open filtered on it</span>
            </nav>
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; flex: 1; overflow: auto; }
    .home { display: flex; flex-direction: column; gap: 1rem; max-width: 52rem; margin: 0 auto; padding: 1.5rem 1.5rem 3rem; font-size: .8125rem; }
    h1 { margin: 0; font-size: 1.25rem; font-weight: 600; }
    .header { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .header h1 { flex: 1; min-width: 0; }
    .switcher-current { font-family: var(--sans, inherit); font-size: .75rem; font-weight: 500; }
    .switcher-prefix { color: var(--mut); font-weight: 400; }
    .project-option { display: flex; align-items: center; gap: .5rem; width: 100%; height: 1.75rem; padding: 0 .5rem; border: 0; border-radius: .375rem; background: transparent; color: var(--fg); font: inherit; font-size: .75rem; text-align: left; cursor: pointer; }
    .project-option[aria-selected='true'], .project-option:hover { background: var(--hover); }
    .project-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .check { width: .75rem; }
    .project-option-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tiles { display: flex; flex-wrap: wrap; gap: .75rem; }
    .tile { flex: 1 1 10rem; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: .375rem; padding: .75rem .875rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); color: var(--fg); text-decoration: none; }
    .tile:hover { border-color: var(--line-2); }
    .tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
    .tile-label { font-size: .6875rem; color: var(--mut); }
    .total { font-family: var(--mono); font-size: 1.25rem; font-weight: 500; letter-spacing: -.02em; color: var(--fg); }
    .pending { color: var(--mut); }
    .lists { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-start; }
    .list { flex: 1 1 18rem; min-width: 0; }
    .list-head { display: flex; align-items: center; gap: .5rem; padding: .625rem .875rem; border-bottom: 1px solid var(--line); }
    .list-count { font-size: .6875rem; color: var(--mut); }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
    .actions-hint { font-size: .6875rem; color: var(--mut); }
    .note { margin: 0; font-size: .75rem; color: var(--mut); display: flex; align-items: center; gap: .5rem; }
    .centred { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 2rem 0; text-align: center; }
    .centred h1 { font-size: .8125rem; }
    .creation { width: 100%; max-width: 28rem; padding: .875rem; text-align: left; }
    .card { border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .card-head { display: flex; align-items: center; gap: .5rem; padding: .625rem .875rem; }
    .card-title { margin: 0; flex: 1; font-size: .8125rem; font-weight: 600; }
    .card-head .card-title { flex: none; }
    .card > .note { padding: .75rem .875rem; }
    .card-body { padding: .75rem .875rem; border-top: 1px solid var(--line); background: var(--sunk); }
    .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: .75rem; color: var(--mut); }
    .rows { list-style: none; margin: 0; padding: 0; }
    .rows li:not(:last-child) { border-bottom: 1px solid var(--line); }
    .row { display: flex; align-items: center; gap: .625rem; padding: .5rem .875rem; color: var(--fg); text-decoration: none; font-size: .8125rem; }
    .row:hover { background: var(--hover); }
    .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .emoji-tile { display: flex; flex: none; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .meta { font-family: var(--mono); font-size: .6875rem; color: var(--mut); }
    .skeleton { display: flex; flex-direction: column; gap: .75rem; }
    .skeleton-block { display: block; border-radius: .625rem; background: var(--sunk); }
    .skeleton-title { width: 12rem; height: 1.5rem; border-radius: .25rem; }
    .skeleton-tiles { display: flex; gap: .75rem; }
    .skeleton-tile { flex: 1; height: 4.5rem; }
    .skeleton-card { height: 6rem; }
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

  protected readonly moveFocusWithinListbox = moveFocusWithinListbox;
  protected readonly firstProject = computed(() => this.projects()[0]);
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

  protected managerMetaOf(session: Session): string {
    const view = this.events.managers().find((candidate) => candidate.sessionId === session.id);
    const model = session.model ?? '';
    if (!view) return model;
    return [model, `pulse ${compactElapsedLabel(view.pulseSeconds)}`, `${view.childrenCount}/${view.childrenCap}`].filter(Boolean).join(' · ');
  }

  protected visibleNameOf(session: Session): string {
    return showInvisibleControlsAsEscapes(session.name);
  }

  protected switchTo({ projectId, popover }: { projectId: string; popover: PopoverComponent }): void {
    popover.close();
    void this.router.navigate(['/project', projectId]);
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
