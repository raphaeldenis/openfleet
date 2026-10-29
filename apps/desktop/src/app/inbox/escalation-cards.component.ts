import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, output, signal, untracked } from '@angular/core';
import type { EscalationQuestionView, EscalationView } from '@openfleet/shared';
import { showBidiControlsAsEscapes, showInvisibleControlsAsEscapes } from '../core/bidi-escapes';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { compactElapsedLabel, elapsedSecondsSince } from '../design/elapsed-time';
import { ErrorLineComponent } from '../design/error-line.component';
import { KindBadgeComponent } from '../design/kind-badge.component';
import { tickingNow } from '../working-state/working-state-freshness';

const UNKNOWN_MANAGER_NAME = 'Unknown manager';
const CLOSED_MANAGER_NAME = 'Closed manager';

const draftKeyOf = (escalationId: string, questionId: string): string => `${escalationId}/${questionId}`;

const isAwaitingHuman = ({ status }: EscalationQuestionView): boolean => status === 'pending_human';

const oldestFirstThenById = (first: EscalationView, second: EscalationView): number => {
  const byCreation = Date.parse(first.createdAt) - Date.parse(second.createdAt);
  if (byCreation !== 0) return byCreation;
  return first.id < second.id ? -1 : 1;
};

const classesLabelOf = ({ effectiveClasses, reason }: EscalationQuestionView): string =>
  [...effectiveClasses, ...(reason ? [reason] : [])].join(', ');

/** The cards of the escalations waiting for a human answer: one answer per pending question, sent together. Every daemon text is drawn as inert plain text. */
@Component({
  selector: 'of-escalation-cards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, KindBadgeComponent],
  template: `
    <div role="status" aria-label="Escalations">
      <span class="sr-only">{{ announcement() }}</span>
    </div>
    @for (card of cards(); track card.id) {
      <article class="card" data-testid="escalation-card" [attr.data-escalation-id]="card.id">
        <span class="avatar" aria-hidden="true">{{ card.managerEmoji }}</span>
        <div class="body">
          <div class="meta">
            <of-kind-badge kind="escalation" />
            <span class="manager" data-testid="escalation-manager">{{ card.managerName }}</span>
            <span class="ticket" data-testid="escalation-ticket">{{ card.ticket }}</span>
            <span class="age" data-testid="escalation-age">{{ card.ageLabel }}</span>
          </div>
          <p class="summary" data-testid="escalation-body">{{ card.summary }}</p>
          <div class="questions" role="group" [attr.aria-label]="'Answer the escalation on ' + card.ticket">
            @for (field of card.fields; track field.questionId) {
              <div class="question" data-testid="escalation-question">
                <label class="question-text" [for]="field.fieldId">{{ field.text }}</label>
                <span class="classes" data-testid="escalation-classes">{{ field.classes }}</span>
                @if (field.options.length > 0) {
                  <ul class="options" aria-label="Options">
                    @for (option of field.options; track $index) {
                      <li>{{ option }}</li>
                    }
                  </ul>
                }
                @if (field.recommendation; as recommendation) {
                  <p class="recommendation" data-testid="escalation-recommendation"><span class="recommendation-label">Manager recommends</span> {{ recommendation }}</p>
                }
                <textarea
                  class="answer"
                  rows="2"
                  [id]="field.fieldId"
                  [value]="field.answer"
                  [readOnly]="card.isPending"
                  (input)="setAnswer(card.id, field.questionId, $any($event.target).value)"
                ></textarea>
              </div>
            }
          </div>
          <p class="hint" [id]="'escalation-hint-' + card.id">Answer every question to send.</p>
          <div class="actions">
            <button type="button" class="of-btn of-btn--primary" data-testid="escalation-submit" [attr.aria-label]="'Send answers for ' + card.ticket" [attr.aria-describedby]="'escalation-hint-' + card.id" [disabled]="!card.canSubmit || card.isPending" (click)="submit(card.id)">Send answers</button>
          </div>
          @if (card.error; as error) {
            <p><of-error-line data-testid="escalation-error" [glyph]="false">{{ error }}</of-error-line></p>
          }
        </div>
      </article>
    }
  `,
  styles: `
    :host { display: contents; }
    .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .card { display: flex; gap: .75rem; min-width: 0; padding: .875rem 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .avatar { display: flex; align-items: center; justify-content: center; flex: none; width: 2rem; height: 2rem; border-radius: .5rem; border: 1px solid var(--line); background: var(--sunk); }
    .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .5rem; }
    .meta { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .manager { font-weight: 500; overflow-wrap: anywhere; }
    .ticket { font-family: var(--mono); font-size: .75rem; color: var(--mut); overflow-wrap: anywhere; }
    .age { margin-left: auto; font-size: .6875rem; color: var(--mut); }
    .summary { margin: 0; font-size: .75rem; color: var(--mut); white-space: pre-wrap; overflow-wrap: anywhere; }
    .questions { display: flex; flex-direction: column; gap: .75rem; }
    .question { display: flex; flex-direction: column; gap: .25rem; min-width: 0; }
    .question-text { font-weight: 500; white-space: pre-wrap; overflow-wrap: anywhere; }
    .classes { font-family: var(--mono); font-size: .6875rem; color: var(--mut); }
    .options { margin: 0; padding: 0 0 0 1rem; font-size: .75rem; overflow-wrap: anywhere; }
    .recommendation { margin: 0; font-size: .75rem; color: var(--mut); white-space: pre-wrap; overflow-wrap: anywhere; }
    .recommendation-label { font-weight: 600; }
    .answer { width: 100%; box-sizing: border-box; padding: .375rem .5rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); color: var(--fg); font: inherit; resize: vertical; }
    .answer:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .hint { margin: 0; font-size: .75rem; color: var(--mut); }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
  `,
})
export class EscalationCardsComponent {
  /** Emitted when the card that had the focus leaves and no other card can take it. */
  readonly noCardLeft = output<void>();
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly now = tickingNow();
  private readonly drafts = signal<Readonly<Record<string, string>>>({});
  private readonly pendingIds = signal<ReadonlySet<string>>(new Set());
  private readonly errorsById = signal<Readonly<Record<string, string>>>({});
  private cardIdsBeforeRender: readonly string[] = [];
  private cardKeepingFocusId: string | undefined;

  constructor() {
    effect(() => {
      const cardIds = this.cards().map((card) => card.id);
      untracked(() => this.passFocusOnWhenItsCardLeft(cardIds));
    });
  }

  private readonly sessionsById = computed(() => new Map(this.events.sessions().map((session) => [session.id, session])));
  private readonly managersById = computed(() => new Map(this.events.managers().map((manager) => [manager.sessionId, manager])));

  private managerNameOf(managerId: string): string {
    const session = this.sessionsById().get(managerId);
    if (session) return showInvisibleControlsAsEscapes(session.name);
    const isStillListedAsManager = this.managersById().has(managerId);
    return isStillListedAsManager ? CLOSED_MANAGER_NAME : UNKNOWN_MANAGER_NAME;
  }

  private readonly sortedEscalations = computed(() => [...this.events.escalations()].sort(oldestFirstThenById));

  protected readonly announcement = computed(() => {
    const count = this.events.escalations().length;
    if (count === 0) return '';
    return count === 1 ? '1 escalation needs you' : `${count} escalations need you`;
  });

  protected readonly cards = computed(() => {
    const nowMs = this.now();
    const drafts = this.drafts();
    return this.sortedEscalations().map((escalation) => {
      const fields = escalation.questions.filter(isAwaitingHuman).map((question) => ({
        questionId: question.questionId,
        fieldId: `escalation-answer-${escalation.id}-${question.questionId}`,
        text: showBidiControlsAsEscapes(question.text),
        classes: showBidiControlsAsEscapes(classesLabelOf(question)),
        options: (question.options ?? []).map(showBidiControlsAsEscapes),
        recommendation: question.recommendation === undefined ? undefined : showBidiControlsAsEscapes(question.recommendation),
        answer: drafts[draftKeyOf(escalation.id, question.questionId)] ?? '',
      }));
      const areAllQuestionsAnswered = fields.length > 0 && fields.every(({ answer }) => answer.trim() !== '');
      return {
        id: escalation.id,
        ticket: showBidiControlsAsEscapes(escalation.ticket),
        managerName: this.managerNameOf(escalation.managerId),
        managerEmoji: this.sessionsById().get(escalation.managerId)?.emoji ?? '',
        ageLabel: compactElapsedLabel(elapsedSecondsSince(escalation.createdAt, nowMs)),
        summary: showBidiControlsAsEscapes(escalation.body),
        fields,
        canSubmit: areAllQuestionsAnswered,
        isPending: this.pendingIds().has(escalation.id),
        error: this.errorsById()[escalation.id],
      };
    });
  });

  protected setAnswer(escalationId: string, questionId: string, answer: string): void {
    this.drafts.update((drafts) => ({ ...drafts, [draftKeyOf(escalationId, questionId)]: answer }));
  }

  protected async submit(escalationId: string): Promise<void> {
    if (this.pendingIds().has(escalationId)) return;
    const card = this.cards().find((candidate) => candidate.id === escalationId);
    if (!card?.canSubmit) return;
    this.cardKeepingFocusId = this.idOfCardHoldingFocus();
    this.setPending(escalationId, true);
    this.errorsById.update((errors) => Object.fromEntries(Object.entries(errors).filter(([id]) => id !== escalationId)));
    try {
      await this.api.answerEscalation(escalationId, { answers: card.fields.map(({ questionId, answer }) => ({ question_id: questionId, answer: answer.trim() })) });
    } catch (error) {
      this.errorsById.update((errors) => ({ ...errors, [escalationId]: copyFor(error, { action: 'generic' }).text }));
    } finally {
      this.setPending(escalationId, false);
    }
  }

  private idOfCardHoldingFocus(): string | undefined {
    const focused = this.host.nativeElement.ownerDocument.activeElement;
    return focused?.closest<HTMLElement>('[data-escalation-id]')?.dataset['escalationId'];
  }

  private passFocusOnWhenItsCardLeft(cardIds: readonly string[]): void {
    const idsBefore = this.cardIdsBeforeRender;
    this.cardIdsBeforeRender = cardIds;
    const focusedId = this.cardKeepingFocusId;
    const hasFocusedCardLeft = focusedId !== undefined && idsBefore.includes(focusedId) && !cardIds.includes(focusedId);
    if (!hasFocusedCardLeft) return;
    this.cardKeepingFocusId = undefined;
    const indexOfLeftCard = idsBefore.indexOf(focusedId);
    afterNextRender(
      () => {
        const cardElements = this.host.nativeElement.querySelectorAll<HTMLElement>('[data-escalation-id]');
        const firstField = cardElements[indexOfLeftCard]?.querySelector<HTMLElement>('textarea');
        if (firstField) firstField.focus();
        else this.noCardLeft.emit();
      },
      { injector: this.injector },
    );
  }

  private setPending(escalationId: string, isPending: boolean): void {
    this.pendingIds.update((ids) => {
      const next = new Set(ids);
      if (isPending) next.add(escalationId);
      else next.delete(escalationId);
      return next;
    });
  }
}
