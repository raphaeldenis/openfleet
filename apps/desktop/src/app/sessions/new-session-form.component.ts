import { DOCUMENT } from '@angular/common';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, Injector, linkedSignal, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, type ParamMap, Router, RouterLink } from '@angular/router';
import { type HarnessId, type Session } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { ManagerFieldsComponent } from '../managers/manager-fields.component';
import { createSessionErrorMessage, SESSION_CREATED_BUT_NOT_OPENED } from './create-session-error';
import { MODEL_RUNGS } from './model-selector.component';
import { type ChosenPermissionMode, PermissionModeListComponent } from './permission-mode-list.component';

type CreationMode = 'session' | 'manager';
type CreatedSession = { id: string; route: '/session' | '/manager' };

const NOT_AVAILABLE_YET = 'not available yet';
const SESSION_DEFAULT_EMOJI = '🤖';
const MANAGER_DEFAULT_EMOJI = '🧭';
const HARNESS_OPTIONS: ReadonlyArray<{ id: string; label: string; isAvailable: boolean }> = [
  { id: 'claude-cli', label: 'Claude Code', isAvailable: true },
  { id: 'codex', label: 'Codex', isAvailable: false },
  { id: 'opencode', label: 'opencode', isAvailable: false },
  { id: 'generic-pty', label: 'Generic PTY', isAvailable: false },
];

const INHERITED_MODE = '';

function creationModeFrom(queryParams: ParamMap | undefined): CreationMode {
  return queryParams?.get('mode') === 'manager' ? 'manager' : 'session';
}

@Component({
  selector: 'of-new-session-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, ManagerFieldsComponent, PermissionModeListComponent],
  template: `
    <form class="of-form" data-testid="new-session-form" (ngSubmit)="submit()" novalidate>
      <div class="header">
        <h1>{{ isManagerMode() ? 'New manager' : 'New session' }}</h1>
        <div class="mode-toggle" role="group" aria-label="Kind of session">
          <button type="button" [attr.aria-pressed]="!isManagerMode()" [disabled]="pending()" data-testid="new-session-mode-session" (click)="chooseMode('session')">Session</button>
          <button type="button" [attr.aria-pressed]="isManagerMode()" [disabled]="pending()" data-testid="new-session-mode-manager" (click)="chooseMode('manager')">Manager</button>
        </div>
      </div>

      <fieldset class="card" [disabled]="pending()">
      <div class="of-section-title">Workspace</div>
      <div class="of-field">
        <label class="of-label" for="new-session-directory">Directory</label>
        <input #directoryInput id="new-session-directory" class="of-input" data-testid="new-session-directory" name="directory" [ngModel]="directory()" (ngModelChange)="directory.set($event)" placeholder="/path/to/worktree" [attr.aria-invalid]="directoryError() ? 'true' : null" [attr.aria-describedby]="directoryError() ? 'new-session-directory-error' : null" />
        @if (directoryError(); as error) {
          <span id="new-session-directory-error" role="alert" data-testid="new-session-directory-error" class="of-error">✕ {{ error }}</span>
        }
      </div>

      <div class="of-section-title">Agent</div>
      <label class="of-field">
        <span class="of-label">Harness</span>
        <select class="of-input" data-testid="new-session-harness" name="harness" [ngModel]="harness()" (ngModelChange)="harness.set($event)">
          @for (option of harnessOptions; track option.id) {
            <option [value]="option.id" [disabled]="!option.isAvailable" [attr.title]="option.isAvailable ? null : notAvailableYet">{{ option.label }}</option>
          }
        </select>
      </label>
      <div class="of-row">
        <label class="of-field">
          <span class="of-label">Model</span>
          <select class="of-input" data-testid="new-session-model" name="model" [ngModel]="model()" (ngModelChange)="model.set($event)">
            @for (rung of modelRungs; track rung) {
              <option [value]="rung">{{ rung }}</option>
            }
          </select>
        </label>
        <of-permission-mode-list class="of-field" [(value)]="permissionMode" />
      </div>

      <div class="of-section-title">Identity</div>
      <div class="of-row">
        <label class="of-field of-field--emoji">
          <span class="of-label">Emoji</span>
          <input class="of-input" data-testid="new-session-emoji" name="emoji" [ngModel]="emoji()" (ngModelChange)="typedEmoji.set($event)" size="2" />
        </label>
        <div class="of-field">
          <label class="of-label" for="new-session-name">Name</label>
          <input #nameInput id="new-session-name" class="of-input" data-testid="new-session-name" name="name" [ngModel]="name()" (ngModelChange)="name.set($event)" placeholder="e.g. Dwalin · T9" [attr.aria-invalid]="nameError() ? 'true' : null" [attr.aria-describedby]="nameError() ? 'new-session-name-error' : null" />
          @if (nameError(); as error) {
            <span id="new-session-name-error" role="alert" data-testid="new-session-name-error" class="of-error">✕ {{ error }}</span>
          }
        </div>
      </div>

      @if (isManagerMode()) {
        <div class="of-section-title">Manager</div>
        <of-manager-fields [(pulseSeconds)]="pulseSeconds" [(childrenCap)]="childrenCap" [(mission)]="mission" />
      }
      </fieldset>

      @if (serverError(); as error) {
        <p role="alert" data-testid="new-session-form-error" class="of-error">✕ {{ error }}</p>
      }
      <div class="actions">
        <a class="of-btn of-btn--secondary" routerLink="/" data-testid="new-session-cancel">Cancel</a>
        <button #submitButton type="submit" class="of-btn of-btn--primary" data-testid="new-session-submit" [disabled]="pending()">{{ isManagerMode() ? 'Create manager' : 'Create session' }}</button>
      </div>
    </form>
  `,
  styles: `
    :host { display: flex; flex: 1; align-items: flex-start; justify-content: center; min-width: 0; padding: 1.5rem 1rem 3rem }
    .of-form { display: flex; flex-direction: column; gap: 1.25rem; width: 46rem; max-width: 100% }
    .header { display: flex; align-items: center; gap: 1rem }
    h1 { flex: 1; margin: 0; font-size: 1.25rem; font-weight: 600; letter-spacing: -.01em }
    .mode-toggle { display: flex; padding: .125rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--sunk) }
    .mode-toggle button { height: 1.625rem; padding: 0 .75rem; border: 0; border-radius: .375rem; background: transparent; color: var(--fg); font: inherit; font-size: .75rem; cursor: pointer }
    .mode-toggle button[aria-pressed='true'] { background: var(--panel) }
    .mode-toggle button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .card { display: flex; flex-direction: column; gap: 1.25rem; min-width: 0; margin: 0; padding: 1.25rem; border: 1px solid var(--line); border-radius: .75rem; background: var(--panel) }
    .of-error { margin: 0 }
    .of-row { display: flex; gap: 1rem }
    .of-row .of-field { flex: 1 }
    .of-row .of-field--emoji { flex: none; width: 3.5rem }
    .actions { display: flex; justify-content: flex-end; gap: .5rem }
    .actions .of-btn { height: 2rem }
    .actions .of-btn--primary { padding: 0 1rem }
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
  private readonly directoryInput = viewChild<ElementRef<HTMLInputElement>>('directoryInput');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly submitButton = viewChild<ElementRef<HTMLButtonElement>>('submitButton');
  private hasBeenDestroyed = false;
  private createdSession: CreatedSession | undefined;
  protected readonly harnessOptions = HARNESS_OPTIONS;
  protected readonly notAvailableYet = NOT_AVAILABLE_YET;
  protected readonly modelRungs = MODEL_RUNGS;

  protected readonly pending = signal(false);
  private readonly modeFromUrl = linkedSignal<{ urlMode: CreationMode; isPending: boolean }, CreationMode>({
    source: () => ({ urlMode: creationModeFrom(this.queryParams()), isPending: this.pending() }),
    computation: ({ urlMode, isPending }, previous) => (isPending && previous ? previous.value : urlMode),
  });
  protected readonly mode = linkedSignal<CreationMode>(() => this.modeFromUrl());
  protected readonly isManagerMode = computed(() => this.mode() === 'manager');
  protected readonly directory = signal('');
  protected readonly name = signal('');
  protected readonly typedEmoji = signal<string | null>(null);
  private readonly defaultEmoji = computed(() => (this.isManagerMode() ? MANAGER_DEFAULT_EMOJI : SESSION_DEFAULT_EMOJI));
  protected readonly emoji = computed(() => this.typedEmoji() ?? this.defaultEmoji());
  protected readonly harness = signal<HarnessId>('claude-cli');
  protected readonly model = signal<string>('sonnet');
  protected readonly permissionMode = signal<ChosenPermissionMode>(INHERITED_MODE);
  protected readonly pulseSeconds = signal(1800);
  protected readonly childrenCap = signal(2);
  protected readonly mission = signal('');

  protected readonly hasSubmitted = signal(false);
  protected readonly serverError = signal('');
  protected readonly directoryError = computed(() => (this.hasSubmitted() && this.directory().trim() === '' ? 'Directory is required' : ''));
  protected readonly nameError = computed(() => (this.hasSubmitted() && this.name().trim() === '' ? 'Name is required' : ''));

  constructor() {
    this.destroyRef.onDestroy(() => (this.hasBeenDestroyed = true));
  }

  protected chooseMode(chosenMode: CreationMode): void {
    this.mode.set(chosenMode);
    const queryParams = chosenMode === 'manager' ? { mode: 'manager' } : {};
    void this.router.navigate([], { relativeTo: this.route, queryParams, replaceUrl: true });
  }

  async submit(): Promise<void> {
    if (this.pending()) return;
    this.serverError.set('');
    this.hasSubmitted.set(true);
    const isRetryOfOpeningCreatedSession = this.createdSession !== undefined;
    if (!isRetryOfOpeningCreatedSession && !this.isValidOrFocusFirstInvalidField()) return;

    const focusWhenSubmitted = this.document.activeElement;
    this.pending.set(true);
    try {
      this.createdSession ??= await this.create();
      if (this.hasBeenDestroyed) return;
      await this.router.navigate([this.createdSession.route, this.createdSession.id]);
    } catch (error) {
      this.serverError.set(this.createdSession ? SESSION_CREATED_BUT_NOT_OPENED : createSessionErrorMessage(error));
      this.restoreFocusDroppedWhilePending(focusWhenSubmitted);
    } finally {
      this.pending.set(false);
    }
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

  private async create(): Promise<CreatedSession> {
    const route = this.isManagerMode() ? '/manager' : '/session';
    const session = await this.createSessionOfCurrentMode();
    return { id: session.id, route };
  }

  private createSessionOfCurrentMode(): Promise<Session> {
    const chosenMode = this.permissionMode();
    const sharedSpec = {
      directory: this.directory().trim(),
      name: this.name().trim(),
      emoji: this.emoji().trim() || this.defaultEmoji(),
      model: this.model(),
      harness: this.harness(),
      ...(chosenMode === INHERITED_MODE ? {} : { permissionMode: chosenMode }),
    };
    if (!this.isManagerMode()) return this.api.createSession(sharedSpec);
    return this.api.createManagerSession({
      ...sharedSpec,
      pulseSeconds: this.pulseSeconds(),
      childrenCap: this.childrenCap(),
      mission: this.mission().trim(),
    });
  }
}
