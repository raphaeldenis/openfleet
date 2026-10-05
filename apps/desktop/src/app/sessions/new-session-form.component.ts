import { DOCUMENT } from '@angular/common';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, Injectable, Injector, linkedSignal, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, type ParamMap, Router, RouterLink } from '@angular/router';
import { type HarnessId, type Project, type Session } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { ManagerFieldsComponent } from '../managers/manager-fields.component';
import { ProjectFormComponent } from '../projects/project-form.component';
import { createdButNotOpenedMessage, createSessionErrorMessage } from './create-session-error';
import { HandoffPickerComponent } from './handoff-picker.component';
import { ApiError } from '../core/fleet-api.service';
import { MODEL_RUNGS } from './model-selector.component';
import { type ChosenPermissionMode, INHERITED_MODE, PermissionModeListComponent } from './permission-mode-list.component';

type CreationMode = 'session' | 'manager';
type CreatedSession = { id: string; formFingerprint: string };
type ServerFailure = { message: string; formFingerprint: string };

const NOT_AVAILABLE_YET = 'not available yet';
const NO_PROJECT_LABEL = 'No project';
const NO_PROJECT_ID = '';
const PROJECT_CREATED_NOTICE = 'Project created';
const SESSION_DEFAULT_EMOJI = '🤖';
const MANAGER_DEFAULT_EMOJI = '🧭';
const HARNESS_OPTIONS: ReadonlyArray<{ id: string; label: string; isAvailable: boolean }> = [
  { id: 'claude-cli', label: 'Claude Code', isAvailable: true },
  { id: 'codex', label: 'Codex', isAvailable: false },
  { id: 'opencode', label: 'opencode', isAvailable: false },
  { id: 'generic-pty', label: 'Generic PTY', isAvailable: false },
];

// A host page that embeds the form provides this in its view providers: it owns the heading, the way out and the kind
// of session, and it shows the prompt it seeds. Dependency injection is the only way in, since a link cannot fill it
// the way it fills a routed component's inputs. It also remembers the session the form created, so a form that the host
// destroys and mounts again opens that session instead of creating a second one.
@Injectable()
export class EmbeddedSessionSeed {
  readonly projectId = signal('');
  readonly directory = signal('');
  readonly name = signal('');
  readonly prompt = signal('');
  readonly createdSession = signal<CreatedSession | undefined>(undefined);
}

function creationModeFrom(queryParams: ParamMap | undefined): CreationMode {
  return queryParams?.get('mode') === 'manager' ? 'manager' : 'session';
}

@Component({
  selector: 'of-new-session-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, FormsModule, RouterLink, ManagerFieldsComponent, PermissionModeListComponent, ProjectFormComponent, HandoffPickerComponent],
  host: { '[class.embedded]': 'isEmbedded' },
  template: `
    <form class="of-form" data-testid="new-session-form" [attr.aria-busy]="pending() || null" (ngSubmit)="submit()" novalidate>
      @if (!isEmbedded) {
        <div class="header">
          <h1>{{ isManagerMode() ? 'New manager' : 'New session' }}</h1>
          <div class="mode-toggle" role="group" aria-label="Kind of session">
            <button type="button" [attr.aria-pressed]="!isManagerMode()" [attr.aria-disabled]="ariaDisabled()" data-testid="new-session-mode-session" (click)="chooseMode('session')">Session</button>
            <button type="button" [attr.aria-pressed]="isManagerMode()" [attr.aria-disabled]="ariaDisabled()" data-testid="new-session-mode-manager" (click)="chooseMode('manager')">Manager</button>
          </div>
        </div>
      }

      <fieldset class="card">
      <div class="of-section-title">Workspace</div>
      <div class="of-field">
        <label class="of-label" for="new-session-directory">Directory</label>
        <input #directoryInput id="new-session-directory" class="of-input" data-testid="new-session-directory" name="directory" [readonly]="pending()" [ngModel]="directory()" (ngModelChange)="directory.set($event)" placeholder="/path/to/worktree" [attr.aria-invalid]="directoryError() ? 'true' : null" [attr.aria-describedby]="directoryError() ? 'new-session-directory-error' : null" />
        @if (directoryError(); as error) {
          <of-error-line id="new-session-directory-error" role="alert" data-testid="new-session-directory-error">{{ error }}</of-error-line>
        }
      </div>
      @if (projects().length > 0) {
        <label class="of-field">
          <span class="of-label">Project</span>
          <select #projectSelect class="of-input" data-testid="new-session-project" name="project" [attr.disabled]="pending() ? '' : null" [ngModel]="projectId()" (ngModelChange)="projectId.set($event)">
            <option [value]="noProjectId">{{ noProjectLabel }}</option>
            @for (project of projects(); track project.id) {
              <option [value]="project.id">{{ project.name }}</option>
            }
          </select>
        </label>
      } @else if (hasLoadedProjects()) {
        <div class="of-field" data-testid="new-session-no-projects">
          <span class="of-label">Project</span>
          <p class="project-empty">No projects yet — <button #createProjectTrigger type="button" class="of-btn of-btn--link" [attr.aria-expanded]="isCreatingProject()" [attr.aria-disabled]="ariaDisabled()" (click)="openProjectForm()">Create a project…</button></p>
        </div>
      }
      @if (isCreatingProject()) {
        <of-project-form (saved)="selectCreatedProject($event)" (cancelled)="closeProjectForm()" />
      }
      @if (hasProjectsLoadFailed()) {
        <p class="project-note" role="status" data-testid="new-session-project-note">Couldn't load your projects. You can still create a session without one.</p>
      }
      @if (!isManagerMode()) {
        <of-handoff-picker [project]="selectedProject()" [file]="handoffFile()" [isLocked]="pending()" (fileChange)="handoffFile.set($event)" />
      }

      <div class="of-section-title">Agent</div>
      <label class="of-field">
        <span class="of-label">Harness</span>
        <select class="of-input" data-testid="new-session-harness" name="harness" [attr.disabled]="pending() ? '' : null" [ngModel]="harness()" (ngModelChange)="harness.set($event)">
          @for (option of harnessOptions; track option.id) {
            <option [value]="option.id" [disabled]="!option.isAvailable" [attr.title]="option.isAvailable ? null : notAvailableYet">{{ option.label }}</option>
          }
        </select>
      </label>
      <div class="of-row">
        <label class="of-field">
          <span class="of-label">Model</span>
          <select class="of-input" data-testid="new-session-model" name="model" [attr.disabled]="pending() ? '' : null" [ngModel]="model()" (ngModelChange)="model.set($event)">
            @for (rung of modelRungs; track rung) {
              <option [value]="rung">{{ rung }}</option>
            }
          </select>
        </label>
        <of-permission-mode-list class="of-field" [(value)]="permissionMode" [isLocked]="pending()" />
      </div>

      <div class="of-section-title">Identity</div>
      <div class="of-row">
        <label class="of-field of-field--emoji">
          <span class="of-label">Emoji</span>
          <input class="of-input" data-testid="new-session-emoji" name="emoji" [readonly]="pending()" [ngModel]="emoji()" (ngModelChange)="typedEmoji.set($event)" size="2" />
        </label>
        <div class="of-field">
          <label class="of-label" for="new-session-name">Name</label>
          <input #nameInput id="new-session-name" class="of-input" data-testid="new-session-name" name="name" [readonly]="pending()" [ngModel]="name()" (ngModelChange)="name.set($event)" placeholder="e.g. Dwalin · T9" [attr.aria-invalid]="nameError() ? 'true' : null" [attr.aria-describedby]="nameError() ? 'new-session-name-error' : null" />
          @if (nameError(); as error) {
            <of-error-line id="new-session-name-error" role="alert" data-testid="new-session-name-error">{{ error }}</of-error-line>
          }
        </div>
      </div>

      @if (isManagerMode()) {
        <div class="of-section-title">Manager</div>
        <of-manager-fields [isLocked]="pending()" [(pulseSeconds)]="pulseSeconds" [(childrenCap)]="childrenCap" [(mission)]="mission" [(isMissionTouched)]="isMissionTouched" />
      }
      </fieldset>

      <div class="footer">
        @if (serverError(); as error) {
          <p role="alert" data-testid="new-session-form-error" class="form-error"><of-error-line>{{ error }}</of-error-line></p>
        }
        <div class="actions">
          <span class="creating" role="status" data-testid="new-session-status">@if (statusText()) {{{ statusText() }}}</span>
          <ng-content />
          @if (!isEmbedded) {
            <a class="of-btn of-btn--secondary" routerLink="/" data-testid="new-session-cancel">Cancel</a>
          }
          <button #submitButton type="submit" class="of-btn of-btn--primary" data-testid="new-session-submit" [disabled]="hasInvalidManagerNumbers()" [attr.aria-disabled]="ariaDisabled()">{{ isManagerMode() ? 'Create manager' : 'Create session' }}</button>
        </div>
      </div>
    </form>
  `,
  styles: `
    :host { display: flex; flex: 1; align-items: flex-start; justify-content: center; min-width: 0; padding: 1.5rem 1rem 3rem }
    .of-form { display: flex; flex-direction: column; gap: 1.25rem; width: 46rem; max-width: 100% }
    .header { display: flex; align-items: center; gap: 1rem }
    :host(.embedded) { padding: 0 }
    :host(.embedded) .of-form { width: 100% }
    .footer { display: flex; flex-direction: column; gap: 1.25rem }
    :host(.embedded) .footer { position: sticky; bottom: 0; gap: .75rem; margin-top: .75rem; padding: .75rem 0; background: var(--bg) }
    h1 { flex: 1; margin: 0; font-size: 1.25rem; font-weight: 600; letter-spacing: -.01em }
    .mode-toggle { display: flex; padding: .125rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--sunk) }
    .mode-toggle button { height: 1.625rem; padding: 0 .75rem; border: 0; border-radius: .375rem; background: transparent; color: var(--fg); font: inherit; font-size: .75rem; cursor: pointer }
    .mode-toggle button[aria-pressed='true'] { background: var(--panel) }
    .mode-toggle button[aria-disabled='true'] { color: var(--mut); cursor: not-allowed }
    .mode-toggle button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .card { display: flex; flex-direction: column; gap: 1.25rem; min-width: 0; margin: 0; padding: 1.25rem; border: 1px solid var(--line); border-radius: .75rem; background: var(--panel) }
    .form-error { margin: 0 }
    .project-note { margin: 0; font-size: .75rem; color: var(--mut) }
    .project-empty { display: flex; align-items: center; gap: .25rem; margin: 0; font-size: .75rem; color: var(--mut) }
    .project-empty .of-btn { padding: 0 .25rem }
    .of-row { display: flex; gap: 1rem }
    .of-row .of-field { flex: 1 }
    .of-row .of-field--emoji { flex: none; width: 3.5rem }
    .actions { display: flex; justify-content: flex-end; align-items: center; gap: .5rem }
    .creating { flex: 1; font-size: .75rem; color: var(--mut) }
    .actions a { display: inline-flex; align-items: center; text-decoration: none }
  `,
})
export class NewSessionFormComponent {
  private readonly api = inject(FleetApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly queryParams = toSignal(this.route.queryParamMap);
  private readonly managerFields = viewChild(ManagerFieldsComponent);
  private readonly permissionModeList = viewChild(PermissionModeListComponent);
  private readonly directoryInput = viewChild<ElementRef<HTMLInputElement>>('directoryInput');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly submitButton = viewChild<ElementRef<HTMLButtonElement>>('submitButton');
  private readonly projectSelect = viewChild<ElementRef<HTMLSelectElement>>('projectSelect');
  private readonly createProjectTrigger = viewChild<ElementRef<HTMLButtonElement>>('createProjectTrigger');
  private hasBeenDestroyed = false;
  protected readonly harnessOptions = HARNESS_OPTIONS;
  protected readonly notAvailableYet = NOT_AVAILABLE_YET;
  protected readonly modelRungs = MODEL_RUNGS;
  protected readonly noProjectLabel = NO_PROJECT_LABEL;
  protected readonly noProjectId = NO_PROJECT_ID;

  private readonly embeddedSessionSeed = inject(EmbeddedSessionSeed, { optional: true });
  protected readonly isEmbedded = this.embeddedSessionSeed !== null;
  protected readonly pending = signal(false);
  readonly isPending = this.pending.asReadonly();
  protected readonly ariaDisabled = computed(() => (this.pending() ? 'true' : null));
  protected readonly statusText = computed(() => (this.pending() ? `Creating ${this.mode()}…` : this.projectCreatedNotice()));
  private readonly createdSession = this.embeddedSessionSeed?.createdSession ?? signal<CreatedSession | undefined>(undefined);
  private readonly modeFromUrl = linkedSignal<{ urlMode: CreationMode; isHoldingMode: boolean }, CreationMode>({
    source: () => ({ urlMode: creationModeFrom(this.queryParams()), isHoldingMode: this.pending() || this.createdSession() !== undefined }),
    computation: ({ urlMode, isHoldingMode }, previous) => (isHoldingMode && previous ? previous.value : urlMode),
  });
  protected readonly mode = linkedSignal<CreationMode>(() => (this.isEmbedded ? 'session' : this.modeFromUrl()));
  protected readonly isManagerMode = computed(() => this.mode() === 'manager');
  protected readonly hasInvalidManagerNumbers = computed(() => this.isManagerMode() && (this.managerFields()?.hasInvalidNumbers() ?? false));
  protected readonly directory = signal(this.embeddedSessionSeed?.directory() ?? '');
  protected readonly name = signal(this.embeddedSessionSeed?.name() ?? '');
  protected readonly typedEmoji = signal<string | null>(null);
  private readonly defaultEmoji = computed(() => (this.isManagerMode() ? MANAGER_DEFAULT_EMOJI : SESSION_DEFAULT_EMOJI));
  protected readonly emoji = computed(() => this.typedEmoji() ?? this.defaultEmoji());
  protected readonly projects = signal<readonly Project[]>([]);
  protected readonly hasLoadedProjects = signal(false);
  protected readonly hasProjectsLoadFailed = signal(false);
  protected readonly isCreatingProject = signal(false);
  protected readonly projectCreatedNotice = signal('');
  protected readonly projectId = signal(this.embeddedSessionSeed?.projectId() ?? this.queryParams()?.get('projectId') ?? NO_PROJECT_ID);
  protected readonly selectedProject = computed(() => this.projects().find((project) => project.id === this.projectId()));
  protected readonly handoffFile = linkedSignal<string | undefined>(() => {
    this.projectId();
    this.isManagerMode();
    return undefined;
  });
  protected readonly harness = signal<HarnessId>('claude-cli');
  protected readonly model = signal<string>('sonnet');
  protected readonly permissionMode = signal<ChosenPermissionMode>(INHERITED_MODE);
  protected readonly pulseSeconds = signal<number | null | undefined>(undefined);
  protected readonly childrenCap = signal(2);
  protected readonly mission = signal('');
  protected readonly isMissionTouched = signal(false);

  protected readonly hasSubmitted = signal(false);
  private readonly serverFailure = signal<ServerFailure | undefined>(undefined);
  private readonly spec = computed(() => {
    const chosenMode = this.permissionMode();
    const chosenProjectId = this.projectId();
    const sharedSpec = {
      directory: this.directory().trim(),
      name: this.name().trim(),
      emoji: this.emoji().trim() || this.defaultEmoji(),
      model: this.model(),
      harness: this.harness(),
      ...(chosenMode === INHERITED_MODE ? {} : { permissionMode: chosenMode }),
      ...(chosenProjectId === NO_PROJECT_ID ? {} : { projectId: chosenProjectId }),
    };
    const seededPrompt = this.embeddedSessionSeed?.prompt().trim();
    const handoffFile = this.handoffFile();
    if (!this.isManagerMode()) return { kind: 'session' as const, fields: { ...sharedSpec, ...(seededPrompt ? { seededPrompt } : {}), ...(handoffFile ? { handoffFile } : {}) } };
    const pulseSeconds = this.pulseSeconds();
    const hasEditedPulseSeconds = typeof pulseSeconds === 'number';
    const managerFields = { ...sharedSpec, ...(hasEditedPulseSeconds ? { pulseSeconds } : {}), childrenCap: this.childrenCap(), mission: this.mission().trim() };
    return { kind: 'manager' as const, fields: managerFields };
  });
  private readonly formFingerprint = computed(() => JSON.stringify(this.spec()));
  protected readonly serverError = computed(() => {
    const failure = this.serverFailure();
    const isFailureOfCurrentForm = failure?.formFingerprint === this.formFingerprint();
    return isFailureOfCurrentForm ? failure.message : '';
  });
  protected readonly directoryError = computed(() => (this.hasSubmitted() && this.directory().trim() === '' ? 'Directory is required' : ''));
  protected readonly nameError = computed(() => (this.hasSubmitted() && this.name().trim() === '' ? 'Name is required' : ''));

  constructor() {
    this.destroyRef.onDestroy(() => (this.hasBeenDestroyed = true));
    void this.loadProjects();
    effect(() => {
      const editedFormFingerprint = this.formFingerprint();
      const isCreatedSessionOfAnotherForm = untracked(() => this.createdSession()?.formFingerprint !== editedFormFingerprint);
      if (isCreatedSessionOfAnotherForm) untracked(() => this.createdSession.set(undefined));
    });
  }

  private async loadProjects(): Promise<void> {
    try {
      const page = await this.api.listProjects();
      const isPageOfProjects = Array.isArray(page?.items);
      if (!isPageOfProjects) return this.hasProjectsLoadFailed.set(true);
      this.projects.set(page.items);
      this.hasLoadedProjects.set(true);
    } catch {
      this.hasProjectsLoadFailed.set(true);
    }
  }

  protected openProjectForm(): void {
    if (this.pending()) return;
    this.projectCreatedNotice.set('');
    this.isCreatingProject.set(true);
  }

  protected closeProjectForm(): void {
    this.isCreatingProject.set(false);
    this.focusAfterRender(() => this.createProjectTrigger()?.nativeElement.focus());
  }

  protected selectCreatedProject(createdProject: Project): void {
    this.projects.update((projects) => [...projects, createdProject]);
    this.projectId.set(createdProject.id);
    this.isCreatingProject.set(false);
    this.projectCreatedNotice.set(PROJECT_CREATED_NOTICE);
    this.focusAfterRender(() => this.projectSelect()?.nativeElement.focus());
  }

  protected chooseMode(chosenMode: CreationMode): void {
    if (this.pending()) return;
    this.mode.set(chosenMode);
    const queryParams = chosenMode === 'manager' ? { mode: 'manager' } : {};
    void this.router.navigate([], { relativeTo: this.route, queryParams, replaceUrl: true });
  }

  async submit(): Promise<void> {
    if (this.pending()) return;
    this.serverFailure.set(undefined);
    if (this.permissionModeList()?.isConfirmingDangerousMode()) return this.permissionModeList()?.demandAnswer();
    this.hasSubmitted.set(true);
    const isRetryOfOpeningCreatedSession = this.createdSession() !== undefined;
    if (!isRetryOfOpeningCreatedSession && !this.isValidOrFocusFirstInvalidField()) return;

    const focusWhenSubmitted = this.document.activeElement;
    this.pending.set(true);
    try {
      const formFingerprint = this.formFingerprint();
      const createdSession = this.createdSession() ?? { id: (await this.createSessionOfCurrentMode()).id, formFingerprint };
      this.createdSession.set(createdSession);
      if (this.hasBeenDestroyed) return;
      const isOpened = await this.router.navigate([`/${this.mode()}`, createdSession.id]);
      if (!isOpened) this.showCreatedButNotOpened(focusWhenSubmitted);
    } catch (error) {
      if (this.createdSession()) this.showCreatedButNotOpened(focusWhenSubmitted);
      else this.showCreateFailed(error, focusWhenSubmitted);
    } finally {
      this.pending.set(false);
    }
  }

  private showCreatedButNotOpened(focusWhenSubmitted: Element | null): void {
    this.showServerError(createdButNotOpenedMessage(this.mode()), focusWhenSubmitted);
  }

  private showCreateFailed(error: unknown, focusWhenSubmitted: Element | null): void {
    const file = this.handoffFile();
    const isMissingHandoff = error instanceof ApiError && error.code === 'handoff_not_found' && file !== undefined;
    const message = isMissingHandoff
      ? `handoffs/${file} is no longer in the docs folder – pick another handoff or remove it.`
      : createSessionErrorMessage(error, this.mode());
    this.showServerError(message, focusWhenSubmitted);
  }

  private showServerError(message: string, focusWhenSubmitted: Element | null): void {
    this.serverFailure.set({ message, formFingerprint: this.formFingerprint() });
    this.restoreFocusDroppedWhilePending(focusWhenSubmitted);
  }

  private isValidOrFocusFirstInvalidField(): boolean {
    const isDirectoryValid = !this.directoryError();
    const isNameValid = !this.nameError();
    const isManagerFieldsValid = !this.isManagerMode() || (this.managerFields()?.validate() ?? false);
    if (!isDirectoryValid) this.focusAfterRender(() => this.directoryInput()?.nativeElement.focus());
    else if (!isNameValid) this.focusAfterRender(() => this.nameInput()?.nativeElement.focus());
    else if (!isManagerFieldsValid) this.focusAfterRender(() => this.managerFields()?.focusFirstInvalidField());
    return isDirectoryValid && isNameValid && isManagerFieldsValid;
  }

  private focusAfterRender(focus: () => void): void {
    afterNextRender(focus, { injector: this.injector });
  }

  private restoreFocusDroppedWhilePending(focusWhenSubmitted: Element | null): void {
    this.focusAfterRender(() => {
      const focusedElement = this.document.activeElement;
      const isFocusDropped = focusedElement === null || focusedElement === this.document.body || focusedElement === focusWhenSubmitted;
      if (isFocusDropped) this.submitButton()?.nativeElement.focus();
    });
  }

  private createSessionOfCurrentMode(): Promise<Session> {
    const spec = this.spec();
    return spec.kind === 'manager' ? this.api.createManagerSession(spec.fields) : this.api.createSession(spec.fields);
  }
}
