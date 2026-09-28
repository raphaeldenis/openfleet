import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { PERMISSION_MODES, type HarnessId, type PermissionMode, type Session } from '@openfleet/shared';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { ManagerFieldsComponent } from '../managers/manager-fields.component';

type CreationMode = 'session' | 'manager';

const MODEL_RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
const NOT_AVAILABLE_YET = 'not available yet';
const HARNESS_OPTIONS: ReadonlyArray<{ id: string; label: string; isAvailable: boolean }> = [
  { id: 'claude-cli', label: 'Claude Code', isAvailable: true },
  { id: 'codex', label: 'Codex', isAvailable: false },
  { id: 'opencode', label: 'opencode', isAvailable: false },
  { id: 'generic-pty', label: 'Generic PTY', isAvailable: false },
];

// ponytail: duplicated from PermissionModePickerComponent to avoid a merge conflict with U2b — share it once U2b lands.
const PERMISSION_MODE_EXPLANATIONS: Record<PermissionMode, string> = {
  manual: 'asks before risky tools, except those you already allowed in your Claude settings',
  acceptEdits: 'File edits run without asking; shell and network still gate.',
  plan: 'Read-only: the agent plans and asks before any change.',
  auto: 'The harness decides from the project allow-list; unknown tools gate.',
  dontAsk: 'Gated tools are denied instead of asked — never blocks, never escalates.',
  bypassPermissions: 'Everything runs. Only for throwaway worktrees; audited and flagged red.',
};
const INHERITED_EXPLANATION = 'No mode set: the CLI uses your own default (Claude settings)';
const INHERITED_MODE = '';
const PERMISSION_MODES_OFFERED_AT_CREATION = PERMISSION_MODES.filter((mode) => mode !== 'bypassPermissions');

@Component({
  selector: 'of-new-session-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, ManagerFieldsComponent],
  template: `
    <form class="of-form" data-testid="new-session-form" (ngSubmit)="submit()" novalidate>
      <div class="header">
        <h2>{{ isManagerMode() ? 'New manager' : 'New session' }}</h2>
        <div class="mode-toggle" role="group" aria-label="Kind of session">
          <button type="button" class="of-btn" [class.of-btn--primary]="!isManagerMode()" [class.of-btn--secondary]="isManagerMode()" [attr.aria-pressed]="!isManagerMode()" data-testid="new-session-mode-session" (click)="mode.set('session')">Session</button>
          <button type="button" class="of-btn" [class.of-btn--primary]="isManagerMode()" [class.of-btn--secondary]="!isManagerMode()" [attr.aria-pressed]="isManagerMode()" data-testid="new-session-mode-manager" (click)="mode.set('manager')">Manager</button>
        </div>
      </div>

      <div class="of-section-title">Workspace</div>
      <label class="of-field">
        <span class="of-label">Directory</span>
        <input class="of-input" data-testid="new-session-directory" name="directory" [ngModel]="directory()" (ngModelChange)="directory.set($event)" placeholder="/path/to/worktree" [attr.aria-invalid]="directoryError() ? 'true' : null" />
        @if (directoryError(); as error) {
          <span role="alert" data-testid="new-session-directory-error" class="of-error">✕ {{ error }}</span>
        }
      </label>

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
        <label class="of-field">
          <span class="of-label">Permission mode</span>
          <select class="of-input" data-testid="new-session-permission-mode" name="permissionMode" [ngModel]="permissionMode()" (ngModelChange)="permissionMode.set($event)">
            <option [value]="inheritedMode">inherited (CLI default)</option>
            @for (mode of permissionModes; track mode) {
              <option [value]="mode">{{ mode }}</option>
            }
          </select>
        </label>
      </div>
      <span class="hint" data-testid="new-session-permission-mode-explanation">{{ permissionModeExplanation() }}</span>

      <div class="of-section-title">Identity</div>
      <div class="of-row">
        <label class="of-field of-field--emoji">
          <span class="of-label">Emoji</span>
          <input class="of-input" data-testid="new-session-emoji" name="emoji" [ngModel]="emoji()" (ngModelChange)="emoji.set($event)" size="2" />
        </label>
        <label class="of-field of-field--grow">
          <span class="of-label">Name</span>
          <input class="of-input" data-testid="new-session-name" name="name" [ngModel]="name()" (ngModelChange)="name.set($event)" placeholder="e.g. Dwalin · T9" [attr.aria-invalid]="nameError() ? 'true' : null" />
          @if (nameError(); as error) {
            <span role="alert" data-testid="new-session-name-error" class="of-error">✕ {{ error }}</span>
          }
        </label>
      </div>

      @if (isManagerMode()) {
        <div class="of-section-title">Manager</div>
        <of-manager-fields [(pulseSeconds)]="pulseSeconds" [(childrenCap)]="childrenCap" [(mission)]="mission" />
      }

      @if (serverError(); as error) {
        <p role="alert" data-testid="new-session-form-error" class="of-error">✕ {{ error }}</p>
      }
      <div class="actions">
        <a class="of-btn of-btn--secondary" routerLink="/" data-testid="new-session-cancel">Cancel</a>
        <button type="submit" class="of-btn of-btn--primary" data-testid="new-session-submit" [disabled]="pending()">{{ isManagerMode() ? 'Create manager' : 'Create session' }}</button>
      </div>
    </form>
  `,
  styles: `
    :host { display: block; flex: 1; min-width: 0; padding: 1.25rem }
    .of-form { display: flex; flex-direction: column; gap: .75rem; max-width: 45rem; padding: 1.25rem; border: 1px solid var(--line); border-radius: .75rem; background: var(--panel) }
    .header { display: flex; align-items: center; justify-content: space-between; gap: 1rem }
    h2 { margin: 0; font-size: 1.125rem }
    .mode-toggle { display: flex; gap: .25rem }
    .of-row { display: flex; gap: 1rem }
    .of-row .of-field { flex: 1 }
    .of-field--emoji { flex: none; width: 3.5rem }
    .hint { font-size: .6875rem; color: var(--mut) }
    .actions { display: flex; justify-content: flex-end; gap: .5rem }
    .actions a { display: inline-flex; align-items: center; text-decoration: none }
  `,
})
export class NewSessionFormComponent {
  private readonly api = inject(FleetApiService);
  private readonly router = inject(Router);
  private readonly queryParams = toSignal(inject(ActivatedRoute).queryParamMap);
  private readonly managerFields = viewChild(ManagerFieldsComponent);
  protected readonly harnessOptions = HARNESS_OPTIONS;
  protected readonly notAvailableYet = NOT_AVAILABLE_YET;
  protected readonly modelRungs = MODEL_RUNGS;
  protected readonly permissionModes = PERMISSION_MODES_OFFERED_AT_CREATION;
  protected readonly inheritedMode = INHERITED_MODE;

  protected readonly mode = linkedSignal<CreationMode>(() => (this.queryParams()?.get('mode') === 'manager' ? 'manager' : 'session'));
  protected readonly isManagerMode = computed(() => this.mode() === 'manager');
  protected readonly directory = signal('');
  protected readonly name = signal('');
  protected readonly emoji = linkedSignal(() => (this.isManagerMode() ? '🧭' : '🤖'));
  protected readonly harness = signal<HarnessId>('claude-cli');
  protected readonly model = signal<string>('sonnet');
  protected readonly permissionMode = signal<PermissionMode | typeof INHERITED_MODE>(INHERITED_MODE);
  protected readonly pulseSeconds = signal(1800);
  protected readonly childrenCap = signal(2);
  protected readonly mission = signal('');

  protected readonly hasSubmitted = signal(false);
  protected readonly serverError = signal('');
  protected readonly pending = signal(false);
  protected readonly directoryError = computed(() => (this.hasSubmitted() && this.directory().trim() === '' ? 'Directory is required' : ''));
  protected readonly nameError = computed(() => (this.hasSubmitted() && this.name().trim() === '' ? 'Name is required' : ''));
  protected readonly permissionModeExplanation = computed(() => {
    const chosenMode = this.permissionMode();
    return chosenMode === INHERITED_MODE ? INHERITED_EXPLANATION : PERMISSION_MODE_EXPLANATIONS[chosenMode];
  });

  async submit(): Promise<void> {
    if (this.pending()) return;
    this.serverError.set('');
    this.hasSubmitted.set(true);
    const isSharedFieldsValid = this.directory().trim() !== '' && this.name().trim() !== '';
    const isManagerFieldsValid = !this.isManagerMode() || (this.managerFields()?.validate() ?? false);
    if (!isSharedFieldsValid || !isManagerFieldsValid) return;

    this.pending.set(true);
    try {
      const session = await this.create();
      await this.router.navigate([this.isManagerMode() ? '/manager' : '/session', session.id]);
    } catch (error) {
      this.serverError.set(error instanceof ApiError ? error.message : 'Could not create the session — check your connection');
    } finally {
      this.pending.set(false);
    }
  }

  private create(): Promise<Session> {
    const chosenMode = this.permissionMode();
    const sharedSpec = {
      directory: this.directory().trim(),
      name: this.name().trim(),
      emoji: this.emoji(),
      model: this.model(),
      harness: this.harness(),
      ...(chosenMode === INHERITED_MODE ? {} : { permissionMode: chosenMode }),
    };
    if (!this.isManagerMode()) return this.api.createSession(sharedSpec);
    return this.api.createManagerSession({
      ...sharedSpec,
      pulseSeconds: this.pulseSeconds(),
      childrenCap: this.childrenCap(),
      mission: this.mission(),
    });
  }
}
