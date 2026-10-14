import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, Injector, input, linkedSignal, output, signal, untracked, viewChild } from '@angular/core';
import { DEFAULT_POST_CREATE_HOOK_TIMEOUT_SECONDS, MAX_POST_CREATE_HOOK_TIMEOUT_SECONDS, type Project, type UpdateProjectRequest } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';

const SCRIPT_REQUIRED = 'Script path is required';
const SCRIPT_NOT_ABSOLUTE = 'Use an absolute path, starting with /';
const TIMEOUT_OUT_OF_RANGE = `The timeout is a whole number of seconds from 1 to ${MAX_POST_CREATE_HOOK_TIMEOUT_SECONDS}`;
const WHOLE_NUMBER = /^\d+$/;

interface HookFields {
  script: string;
  timeoutSeconds: number | null;
}

let nextSettingSequence = 0;

/** Shows the script that runs in every new worktree of a project and edits it: a path, an optional timeout, or no hook at all. */
@Component({
  selector: 'of-project-hook-setting',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent],
  template: `
    <section class="card" aria-labelledby="hook-title">
      <div class="card-head">
        <h2 id="hook-title" class="card-title">Post-create hook</h2>
        <span class="script" [attr.title]="project().postCreateHookScript">{{ project().postCreateHookScript ?? 'No hook' }}</span>
        @if (!isEditing()) {
          <button #openButton type="button" class="of-btn of-btn--secondary of-btn--compact" (click)="startEditing()">{{ project().postCreateHookScript ? 'Change…' : 'Set a hook…' }}</button>
        }
      </div>
      @if (timeoutSummary(); as summary) {
        <p class="line">{{ summary }}</p>
      }
      <p class="line warning">{{ securityWarning }}</p>
      @if (isEditing()) {
        <div class="card-body" role="group" aria-label="Edit the post-create hook" [attr.aria-busy]="pending() || null" (keydown.escape)="cancelOnEscape($event)">
          <div class="of-field">
            <label class="of-label" [for]="scriptId">Script path</label>
            <input #scriptInput [id]="scriptId" class="of-input" placeholder="/path/to/setup.sh" [value]="script()" [readonly]="pending()" (input)="editScript($event)" (keydown.enter)="saveOnEnter($event)" [attr.aria-invalid]="scriptError() ? 'true' : null" [attr.aria-describedby]="scriptError() ? scriptErrorId : null" />
            @if (scriptError(); as error) {
              <of-error-line [id]="scriptErrorId" role="alert">{{ error }}</of-error-line>
            }
          </div>
          <div class="of-field">
            <label class="of-label" [for]="timeoutId">Timeout in seconds</label>
            <input #timeoutInput [id]="timeoutId" class="of-input timeout" inputmode="numeric" [placeholder]="defaultTimeout" [value]="timeout()" [readonly]="pending()" (input)="editTimeout($event)" (keydown.enter)="saveOnEnter($event)" [attr.aria-invalid]="timeoutError() ? 'true' : null" [attr.aria-describedby]="timeoutError() ? timeoutErrorId : timeoutHintId" />
            <span [id]="timeoutHintId" class="hint">Optional, 1 to {{ maxTimeout }}. The script and every process it started are stopped at the timeout.</span>
            @if (timeoutError(); as error) {
              <of-error-line [id]="timeoutErrorId" role="alert">{{ error }}</of-error-line>
            }
          </div>
          @if (saveFailure(); as failure) {
            <of-error-line role="alert">{{ failure }}</of-error-line>
          }
          <div class="actions">
            @if (project().postCreateHookScript) {
              <button type="button" class="of-btn of-btn--secondary remove" [attr.aria-disabled]="pending() ? 'true' : null" (click)="removeHook()">Remove hook</button>
            }
            <button type="button" class="of-btn of-btn--secondary" [attr.aria-disabled]="pending() ? 'true' : null" (click)="cancel()">Cancel</button>
            <button type="button" class="of-btn of-btn--primary" [attr.aria-disabled]="pending() ? 'true' : null" (click)="save()">Save</button>
          </div>
        </div>
      }
    </section>
  `,
  styles: `
    :host { display: block; }
    .card { border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .card-head { display: flex; align-items: center; gap: .5rem; padding: .625rem .875rem; }
    .card-title { margin: 0; flex: none; font-size: .8125rem; font-weight: 600; }
    .script { flex: 1; min-width: 0; font-family: var(--mono); font-size: .75rem; color: var(--mut); overflow-wrap: anywhere; }
    .line { margin: 0; padding: 0 .875rem .625rem; font-size: .6875rem; color: var(--mut); }
    .warning { color: var(--fg); }
    .card-body { display: flex; flex-direction: column; gap: 1rem; padding: .75rem .875rem; border-top: 1px solid var(--line); background: var(--sunk); }
    .timeout { max-width: 8rem; }
    .hint { font-size: .75rem; color: var(--mut); }
    .actions { display: flex; justify-content: flex-end; gap: .5rem; }
    .remove { margin-right: auto; }
  `,
})
export class ProjectHookSettingComponent {
  private readonly api = inject(FleetApiService);
  private readonly injector = inject(Injector);
  private readonly openButton = viewChild<ElementRef<HTMLButtonElement>>('openButton');
  private readonly scriptInput = viewChild<ElementRef<HTMLInputElement>>('scriptInput');
  private readonly timeoutInput = viewChild<ElementRef<HTMLInputElement>>('timeoutInput');
  private hasBeenDestroyed = false;

  readonly project = input.required<Project>();
  readonly saved = output<Project>();

  private readonly sequence = nextSettingSequence++;
  protected readonly scriptId = `hook-script-${this.sequence}`;
  protected readonly scriptErrorId = `hook-script-error-${this.sequence}`;
  protected readonly timeoutId = `hook-timeout-${this.sequence}`;
  protected readonly timeoutHintId = `hook-timeout-hint-${this.sequence}`;
  protected readonly timeoutErrorId = `hook-timeout-error-${this.sequence}`;
  protected readonly defaultTimeout = String(DEFAULT_POST_CREATE_HOOK_TIMEOUT_SECONDS);
  protected readonly maxTimeout = MAX_POST_CREATE_HOOK_TIMEOUT_SECONDS;
  protected readonly securityWarning =
    "The script runs on this computer as the daemon's user, with no shell, inside every worktree created for a session of this project. Point it only at a script you trust and that only you can write.";

  protected readonly isEditing = signal(false);
  protected readonly pending = signal(false);
  protected readonly script = linkedSignal(() => this.project().postCreateHookScript ?? '');
  protected readonly timeout = linkedSignal(() => String(this.project().postCreateHookTimeoutSeconds ?? ''));
  protected readonly scriptError = signal('');
  protected readonly timeoutError = signal('');
  protected readonly saveFailure = signal('');

  private readonly editedProjectId = computed(() => this.project().id);

  protected readonly timeoutSummary = computed(() => {
    const { postCreateHookScript, postCreateHookTimeoutSeconds } = this.project();
    if (!postCreateHookScript) return '';
    if (postCreateHookTimeoutSeconds) return `Times out after ${postCreateHookTimeoutSeconds} s`;
    return `Times out after ${DEFAULT_POST_CREATE_HOOK_TIMEOUT_SECONDS} s (default)`;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.hasBeenDestroyed = true));
    effect(() => {
      this.editedProjectId();
      untracked(() => this.closeEditor());
    });
  }

  protected startEditing(): void {
    this.isEditing.set(true);
    afterNextRender(() => this.scriptInput()?.nativeElement.focus(), { injector: this.injector });
  }

  protected editScript(event: Event): void {
    this.script.set((event.target as HTMLInputElement).value);
    this.scriptError.set('');
    this.saveFailure.set('');
  }

  protected editTimeout(event: Event): void {
    this.timeout.set((event.target as HTMLInputElement).value);
    this.timeoutError.set('');
    this.saveFailure.set('');
  }

  protected saveOnEnter(event: Event): void {
    event.preventDefault();
    void this.save();
  }

  protected cancelOnEscape(event: Event): void {
    event.stopPropagation();
    this.cancel();
  }

  protected cancel(): void {
    if (this.pending()) return;
    this.closeEditor();
    afterNextRender(() => this.openButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async save(): Promise<void> {
    if (this.pending()) return;
    const fields = this.validFieldsOrFocusFirstInvalid();
    if (!fields) return;
    await this.send({ postCreateHookScript: fields.script, postCreateHookTimeoutSeconds: fields.timeoutSeconds });
  }

  protected async removeHook(): Promise<void> {
    if (this.pending()) return;
    await this.send({ postCreateHookScript: null });
  }

  private async send(patch: UpdateProjectRequest): Promise<void> {
    this.saveFailure.set('');
    this.pending.set(true);
    try {
      const project = await this.api.updateProject(this.project().id, patch);
      if (this.hasBeenDestroyed) return;
      this.closeEditor();
      afterNextRender(() => this.openButton()?.nativeElement.focus(), { injector: this.injector });
      this.saved.emit(project);
    } catch (error) {
      this.saveFailure.set(copyFor(error, { action: 'save_project_hook' }).text);
    } finally {
      this.pending.set(false);
    }
  }

  private validFieldsOrFocusFirstInvalid(): HookFields | undefined {
    const script = this.script().trim();
    const timeoutText = this.timeout().trim();
    const scriptError = script === '' ? SCRIPT_REQUIRED : script.startsWith('/') ? '' : SCRIPT_NOT_ABSOLUTE;
    const timeoutSeconds = timeoutText === '' ? null : WHOLE_NUMBER.test(timeoutText) ? Number(timeoutText) : Number.NaN;
    const isTimeoutInvalid = timeoutSeconds !== null && !(timeoutSeconds >= 1 && timeoutSeconds <= MAX_POST_CREATE_HOOK_TIMEOUT_SECONDS);
    this.scriptError.set(scriptError);
    this.timeoutError.set(isTimeoutInvalid ? TIMEOUT_OUT_OF_RANGE : '');
    if (scriptError) return this.focusAfterRender(() => this.scriptInput()?.nativeElement.focus());
    if (isTimeoutInvalid) return this.focusAfterRender(() => this.timeoutInput()?.nativeElement.focus());
    return { script, timeoutSeconds };
  }

  private closeEditor(): void {
    this.isEditing.set(false);
    this.scriptError.set('');
    this.timeoutError.set('');
    this.saveFailure.set('');
  }

  private focusAfterRender(focus: () => void): undefined {
    afterNextRender(focus, { injector: this.injector });
    return undefined;
  }
}
