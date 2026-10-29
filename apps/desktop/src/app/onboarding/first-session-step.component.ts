import { ChangeDetectionStrategy, Component, computed, inject, output, viewChild } from '@angular/core';
import { EmbeddedSessionSeed, NewSessionFormComponent } from '../sessions/new-session-form.component';
import { STEP_PANEL_STYLES } from './step-panel.styles';

const FIRST_SESSION_NAME = 'First session';
const FIRST_SESSION_SEEDED_PROMPT = 'Read the README and give me a short tour of this project. Do not modify any files.';

/** The host provides EmbeddedSessionSeed, filled with the project and directory before this step is shown; the seed outlives the step so Back then Continue reopens a session already created. */
@Component({
  selector: 'of-first-session-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NewSessionFormComponent],
  template: `
    <section class="step-panel" data-testid="onboarding-step-first-session">
      <header>
        <span class="kicker">Step 6 of 6 · First session</span>
        <h1>Start your first session</h1>
        <p>Land in a terminal in under a minute.</p>
      </header>
      <p class="seeded-prompt">The session starts by sending this prompt: <q>{{ seededPrompt }}</q></p>
      <of-new-session-form>
        <button type="button" class="of-btn of-btn--secondary back" [attr.aria-disabled]="isCreatingFirstSession() || null" (click)="goBack()">Back</button>
      </of-new-session-form>
    </section>
  `,
  styles: [
    STEP_PANEL_STYLES,
    `
    :host { display: contents }
    .seeded-prompt { margin: 0; font-size: .75rem; color: var(--mut) }
    .back { margin-right: auto }
  `,
  ],
})
export class FirstSessionStepComponent {
  /** Emits when the user asks to return to the project step; ignored while the session is being created. */
  readonly back = output<void>();

  protected readonly seededPrompt = FIRST_SESSION_SEEDED_PROMPT;
  private readonly firstSessionForm = viewChild(NewSessionFormComponent);
  protected readonly isCreatingFirstSession = computed(() => this.firstSessionForm()?.isPending() ?? false);

  constructor() {
    const firstSessionSeed = inject(EmbeddedSessionSeed);
    firstSessionSeed.name.set(FIRST_SESSION_NAME);
    firstSessionSeed.prompt.set(FIRST_SESSION_SEEDED_PROMPT);
  }

  protected goBack(): void {
    if (this.isCreatingFirstSession()) return;
    this.back.emit();
  }
}
