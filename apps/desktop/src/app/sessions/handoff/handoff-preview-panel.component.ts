import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, effect, input, output, viewChild } from '@angular/core';
import type { HandoffContent, HandoffSectionKey, HandoffSectionSource } from '@openfleet/shared';
import { HandoffSectionFieldComponent } from './handoff-section-field.component';
import type { HandoffPreviewState } from './handoff-preview.store';

export type HandoffPanelDensity = 'compact' | 'roomy';

export type HandoffSubject = 'session' | 'manager';

const SECTION_LABELS: ReadonlyArray<{ key: HandoffSectionKey; label: string; placeholder: string }> = [
  { key: 'goal', label: 'Goal', placeholder: '' },
  { key: 'state', label: 'State', placeholder: 'Where things stand' },
  { key: 'decisions', label: 'Decisions', placeholder: 'Choices made and why' },
  { key: 'filesTouched', label: 'Files touched', placeholder: 'Changed files' },
  { key: 'nextSteps', label: 'Next steps', placeholder: 'What the next session should do first' },
  { key: 'openQuestions', label: 'Open questions', placeholder: 'Anything unresolved' },
];

const GOAL_PLACEHOLDER_BY_SUBJECT: Record<HandoffSubject, string> = {
  session: 'What this session was for',
  manager: 'What this manager was for',
};

const STATES_WITH_FIELDS: ReadonlySet<HandoffPreviewState> = new Set(['ready', 'saving', 'saved', 'error']);
const STATES_THAT_CAN_SAVE: ReadonlySet<HandoffPreviewState> = new Set(['ready', 'error']);
const STATES_WITH_ERROR_ROW: ReadonlySet<HandoffPreviewState> = new Set(['error', 'loadFailed']);

const SAVE_LABEL: Partial<Record<HandoffPreviewState, string>> & { ready: string } = {
  ready: 'Save handoff',
  saving: 'Saving…',
  saved: 'Saved ✓',
};

const DEFAULT_AUTO_CLOSE_DELAY_MS = 2000;

let nextPanelId = 0;

@Component({
  selector: 'of-handoff-preview-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HandoffSectionFieldComponent],
  template: `
    <div
      class="panel"
      role="dialog"
      aria-modal="false"
      [attr.aria-labelledby]="titleId"
      [attr.data-density]="density()"
      (keydown.escape)="cancelUnlessSaving()"
    >
      <div class="header">
        <span #title class="title" tabindex="-1" [id]="titleId">Handoff preview</span>
        @if (relativePath(); as path) {
          <span class="path">→ {{ path }}</span>
        }
        <span class="spacer"></span>
        @if (isSaved()) {
          <button type="button" class="of-btn of-btn--link of-btn--compact" (click)="openSaved.emit()">Saved · open in Notes › handoffs</button>
        } @else {
          <span class="meta">{{ metaText() }}</span>
        }
      </div>

      <div class="status" role="status" aria-live="polite">
        @if (isLoading()) {
          <span class="spinner" data-testid="handoff-spinner" aria-hidden="true"></span>
        }
        {{ statusText() }}
      </div>

      @if (showsError()) {
        <div class="error-row" role="alert">
          <span class="error-glyph" aria-hidden="true">✕</span>
          <span class="error-text">{{ error() }}</span>
          <button type="button" class="of-btn of-btn--primary of-btn--compact" (click)="retry.emit()">Try again</button>
        </div>
      }

      @if (showsFields()) {
        <div class="fields">
          @for (section of sectionFields(); track section.key) {
            <of-handoff-section-field
              [label]="section.label"
              [placeholder]="section.placeholder"
              [value]="sections()[section.key]"
              [source]="sources()[section.key]"
              [disabled]="isLocked()"
              (valueChange)="changeSection(section.key, $event)"
            />
          }
        </div>
      }

      <div class="actions">
        @if (saveDisabledReason(); as reason) {
          <span class="reason" [id]="reasonId">{{ reason }}</span>
        }
        <button type="button" class="of-btn of-btn--secondary" (click)="cancel.emit()">Cancel</button>
        @if (showsSaveButton()) {
          <button
            type="button"
            class="of-btn of-btn--primary"
            [attr.aria-disabled]="isSaveBlocked()"
            [attr.aria-describedby]="saveDisabledReason() ? reasonId : null"
            (click)="saveUnlessBlocked()"
          >
            {{ saveLabel() }}
          </button>
        }
      </div>
    </div>
  `,
  styles: `
    .panel {
      display: flex; flex-direction: column; gap: .625rem; padding: .875rem 1rem;
      border-bottom: 1px solid var(--line); background: var(--sunk); color: var(--fg); font-size: .75rem;
    }
    .panel[data-density='roomy'] { padding: 1.25rem; }
    .header { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .title { font-weight: 600; outline: none; }
    .path { font-family: var(--mono); color: var(--mut); }
    .spacer { flex: 1; }
    .meta { color: var(--mut); }
    .status { display: flex; align-items: center; gap: .5rem; color: var(--mut); }
    .status:empty { display: none; }
    .spinner {
      width: .75rem; height: .75rem; border: 2px solid var(--line); border-top-color: var(--accent);
      border-radius: 50%; animation: handoff-spin .8s linear infinite;
    }
    @keyframes handoff-spin { to { transform: rotate(360deg); } }
    .error-row { display: flex; align-items: center; gap: .5rem; color: var(--fg); }
    .error-glyph { color: var(--state-error); }
    .error-text { flex: 1; }
    .fields { display: flex; flex-wrap: wrap; gap: .625rem; }
    .fields > of-handoff-section-field { flex: 1 1 15rem; }
    .actions { display: flex; align-items: center; justify-content: flex-end; gap: .5rem; flex-wrap: wrap; }
    .reason { flex: 1; color: var(--mut); }
  `,
})
export class HandoffPreviewPanelComponent {
  readonly state = input.required<HandoffPreviewState>();
  readonly relativePath = input<string>();
  readonly sections = input.required<HandoffContent>();
  readonly sources = input.required<Record<HandoffSectionKey, HandoffSectionSource>>();
  readonly metaText = input('');
  readonly error = input<string>();
  readonly saveDisabledReason = input<string>();
  readonly density = input<HandoffPanelDensity>('compact');
  readonly subject = input<HandoffSubject>('session');
  readonly autoCloseDelayMs = input(DEFAULT_AUTO_CLOSE_DELAY_MS);

  readonly save = output<void>();
  /** The host hides the panel and restores focus to the control that opened it. */
  readonly cancel = output<void>();
  /** The saved confirmation was shown long enough: the host hides the panel and restores focus. */
  readonly autoClose = output<void>();
  readonly retry = output<void>();
  readonly openSaved = output<void>();
  readonly sectionsChange = output<HandoffContent>();

  protected readonly sectionFields = computed(() =>
    SECTION_LABELS.map((section) => (section.key === 'goal' ? { ...section, placeholder: GOAL_PLACEHOLDER_BY_SUBJECT[this.subject()] } : section)),
  );
  protected readonly titleId = `of-handoff-title-${nextPanelId}`;
  protected readonly reasonId = `of-handoff-reason-${nextPanelId++}`;

  private readonly title = viewChild.required<ElementRef<HTMLElement>>('title');

  protected readonly isLoading = computed(() => this.state() === 'loading');
  protected readonly isSaved = computed(() => this.state() === 'saved');
  protected readonly isLocked = computed(() => this.state() === 'saving' || this.state() === 'saved');
  protected readonly showsFields = computed(() => STATES_WITH_FIELDS.has(this.state()));
  protected readonly showsSaveButton = computed(() => this.state() !== 'loadFailed');
  protected readonly showsError = computed(() => STATES_WITH_ERROR_ROW.has(this.state()) && !!this.error());
  protected readonly isSaveBlocked = computed(() => !STATES_THAT_CAN_SAVE.has(this.state()) || !!this.saveDisabledReason());
  protected readonly saveLabel = computed(() => SAVE_LABEL[this.state()] ?? SAVE_LABEL.ready);
  protected readonly statusText = computed(() => {
    switch (this.state()) {
      case 'loading':
        return 'Collecting the state…';
      case 'saving':
        return 'Saving…';
      case 'saved':
        return `Saved to ${this.relativePath() ?? 'handoffs'}`;
      default:
        return '';
    }
  });

  constructor() {
    afterNextRender(() => this.title().nativeElement.focus());
    effect((onCleanup) => {
      if (!this.isSaved()) return;
      const timer = setTimeout(() => this.autoClose.emit(), this.autoCloseDelayMs());
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected saveUnlessBlocked(): void {
    if (this.isSaveBlocked()) return;
    this.save.emit();
  }

  protected cancelUnlessSaving(): void {
    if (this.state() === 'saving') return;
    this.cancel.emit();
  }

  protected changeSection(key: HandoffSectionKey, text: string): void {
    this.sectionsChange.emit({ ...this.sections(), [key]: text });
  }
}
