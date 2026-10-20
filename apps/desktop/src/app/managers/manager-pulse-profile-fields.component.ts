import { ChangeDetectionStrategy, Component, computed, ElementRef, input, model, signal, viewChild, viewChildren } from '@angular/core';
import { MAX_EXPERTISE_LENGTH, MAX_PULSE_ACTIONS, MAX_PULSE_ACTION_LENGTH } from '@openfleet/shared';
import { ErrorLineComponent } from '../design/error-line.component';

const BLANK_ACTION_ERROR = 'Write the action or remove it';
const DUPLICATE_ACTION_ERROR = 'This action is already in the list';
const LONG_ACTION_ERROR = `An action must be at most ${MAX_PULSE_ACTION_LENGTH} characters`;
const LONG_EXPERTISE_ERROR = `Expertise must be at most ${MAX_EXPERTISE_LENGTH} characters`;

const valueOf = (event: Event) => (event.target as HTMLInputElement | HTMLTextAreaElement).value;

/** The expertise and the pulse actions a manager keeps on its card: a counted text, and a list of 0 to 12 short lines. */
@Component({
  selector: 'of-manager-pulse-profile-fields',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent],
  template: `
    <div class="of-field">
      <label class="of-label" for="manager-expertise">Expertise</label>
      <textarea
        #expertiseInput id="manager-expertise" class="of-input of-input--textarea" data-testid="manager-expertise" [readonly]="isLocked()" [value]="expertise()"
        (input)="expertise.set(valueOf($event))" placeholder="What this manager is good at" [attr.aria-invalid]="expertiseError() ? 'true' : null"
        [attr.aria-describedby]="expertiseError() ? 'manager-expertise-count manager-expertise-error' : 'manager-expertise-count'"
      ></textarea>
      <span id="manager-expertise-count" class="hint count" data-testid="manager-expertise-count">{{ expertiseLength() }} / ${MAX_EXPERTISE_LENGTH}</span>
      @if (expertiseError(); as error) {
        <of-error-line id="manager-expertise-error" role="alert">{{ error }}</of-error-line>
      }
    </div>
    <div class="of-field" role="group" aria-labelledby="manager-pulse-actions-label">
      <div class="head">
        <span id="manager-pulse-actions-label" class="of-label">Pulse actions</span>
        <span class="hint" data-testid="manager-pulse-actions-count">{{ pulseActions().length }} / ${MAX_PULSE_ACTIONS}</span>
      </div>
      @for (action of pulseActions(); track $index) {
        <div class="action">
          <input
            #actionInput class="of-input" type="text" [value]="action" [readonly]="isLocked()" [attr.aria-label]="'Pulse action ' + ($index + 1)"
            (input)="editAction($index, valueOf($event))" [attr.aria-invalid]="actionErrors()[$index] ? 'true' : null"
          />
          <button type="button" class="of-btn of-btn--secondary" [disabled]="isLocked()" [attr.aria-label]="'Remove pulse action ' + ($index + 1)" (click)="removeAction($index)">Remove</button>
        </div>
        @if (actionErrors()[$index]; as error) {
          <of-error-line role="alert">{{ error }}</of-error-line>
        }
      }
      <div class="add">
        <button type="button" class="of-btn of-btn--secondary" [disabled]="isLocked() || isListFull()" (click)="addAction()">Add pulse action</button>
        @if (isListFull()) {
          <span class="hint" role="status">${MAX_PULSE_ACTIONS} actions at most</span>
        }
      </div>
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 1.25rem }
    .head { display: flex; align-items: baseline; justify-content: space-between }
    .hint { font-size: .6875rem; color: var(--mut) }
    .count { align-self: flex-end }
    .action { display: flex; gap: .5rem; align-items: center }
    .action .of-input { flex: 1 }
    .add { display: flex; align-items: center; gap: .75rem }
  `,
})
export class ManagerPulseProfileFieldsComponent {
  readonly isLocked = input(false);
  readonly expertise = model('');
  readonly pulseActions = model<string[]>([]);
  private readonly expertiseInput = viewChild<ElementRef<HTMLTextAreaElement>>('expertiseInput');
  private readonly actionInputs = viewChildren<ElementRef<HTMLInputElement>>('actionInput');
  private readonly showsBlankActionErrors = signal(false);

  protected readonly valueOf = valueOf;
  protected readonly expertiseLength = computed(() => this.expertise().trim().length);
  protected readonly expertiseError = computed(() => (this.expertiseLength() > MAX_EXPERTISE_LENGTH ? LONG_EXPERTISE_ERROR : ''));
  protected readonly isListFull = computed(() => this.pulseActions().length >= MAX_PULSE_ACTIONS);
  protected readonly actionErrors = computed(() => {
    const trimmedActions = this.pulseActions().map((action) => action.trim());
    return trimmedActions.map((action, index) => {
      if (action === '') return this.showsBlankActionErrors() ? BLANK_ACTION_ERROR : '';
      if (action.length > MAX_PULSE_ACTION_LENGTH) return LONG_ACTION_ERROR;
      const repeatsAnEarlierAction = trimmedActions.indexOf(action) < index;
      return repeatsAnEarlierAction ? DUPLICATE_ACTION_ERROR : '';
    });
  });
  readonly hasInvalidFields = computed(() => this.expertiseError() !== '' || this.actionErrors().some((error) => error !== ''));

  validate(): boolean {
    this.showsBlankActionErrors.set(true);
    return !this.hasInvalidFields();
  }

  focusFirstInvalidField(): void {
    if (this.expertiseError()) return this.expertiseInput()?.nativeElement.focus();
    const firstInvalidIndex = this.actionErrors().findIndex((error) => error !== '');
    this.actionInputs()[firstInvalidIndex]?.nativeElement.focus();
  }

  protected addAction(): void {
    if (this.isListFull()) return;
    this.pulseActions.update((actions) => [...actions, '']);
  }

  protected removeAction(index: number): void {
    this.pulseActions.update((actions) => actions.filter((_, position) => position !== index));
  }

  protected editAction(index: number, text: string): void {
    this.pulseActions.update((actions) => actions.map((action, position) => (position === index ? text : action)));
  }
}
