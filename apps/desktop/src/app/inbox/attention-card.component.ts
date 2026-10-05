import { ChangeDetectionStrategy, Component, ElementRef, computed, input, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MANAGER_ROLE } from '@openfleet/shared';
import { compactElapsedLabel, elapsedSecondsSince } from '../design/elapsed-time';
import { KindBadgeComponent } from '../design/kind-badge.component';
import { ComposerComponent } from '../sessions/composer.component';
import { tickingNow } from '../working-state/working-state-freshness';
import type { AttentionItem } from '../working-state/attention-items';
import { showBidiControlsAsEscapes, showInvisibleControlsAsEscapes } from '../core/bidi-escapes';

@Component({
  selector: 'of-attention-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KindBadgeComponent, RouterLink, ComposerComponent],
  template: `
    <article class="card" [class.card--answered]="item().isAnswered" data-testid="inbox-attention-card" (keydown.escape)="returnFocusToSessionLink()">
      <span class="avatar" aria-hidden="true">{{ item().session.emoji }}</span>
      <div class="body">
        <div class="meta">
          <of-kind-badge kind="question" />
          @if (item().isAnswered) {
            <span class="answered" data-testid="inbox-attention-answered">Reply delivered</span>
          }
          <a #sessionLink class="session-link" data-testid="inbox-attention-session" [routerLink]="sessionRoute()">{{ sessionName() }}</a>
          <span class="age" data-testid="inbox-attention-age">{{ ageLabel() }}</span>
        </div>
        @if (questions().length > 0) {
          <ul class="lines">
            @for (line of questions(); track $index) {
              <li class="line" data-testid="inbox-attention-question">{{ line }}</li>
            }
          </ul>
        }
        @if (blockers().length > 0) {
          <ul class="lines lines--blockers">
            @for (line of blockers(); track $index) {
              <li class="line" data-testid="inbox-attention-blocker">{{ line }}</li>
            }
          </ul>
        }
        <of-composer [sessionId]="item().session.id" [busy]="item().session.state === 'generating'" />
      </div>
    </article>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .card { display: flex; gap: .75rem; min-width: 0; padding: .875rem 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .card--answered { opacity: .6; }
    .answered { font-size: .6875rem; color: var(--mut); }
    .avatar { display: flex; align-items: center; justify-content: center; flex: none; width: 2rem; height: 2rem; border-radius: .5rem; border: 1px solid var(--line); background: var(--sunk); }
    .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .5rem; }
    .meta { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; min-width: 0; }
    .session-link { min-width: 0; font-weight: 500; color: var(--fg); overflow-wrap: anywhere; }
    .session-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .age { margin-left: auto; font-size: .6875rem; color: var(--mut); }
    .lines { margin: 0; padding: 0 0 0 1rem; display: flex; flex-direction: column; gap: .125rem; }
    .lines--blockers { color: var(--mut); }
    .line { min-width: 0; overflow-wrap: anywhere; }
    of-composer { display: block; margin: 0 -.75rem; }
  `,
})
export class AttentionCardComponent {
  readonly item = input.required<AttentionItem>();
  private readonly now = tickingNow();
  private readonly sessionLink = viewChild.required<ElementRef<HTMLAnchorElement>>('sessionLink');
  protected readonly sessionName = computed(() => showInvisibleControlsAsEscapes(this.item().session.name));
  protected readonly questions = computed(() => this.item().questions.map(showBidiControlsAsEscapes));
  protected readonly blockers = computed(() => this.item().blockers.map(showBidiControlsAsEscapes));
  protected readonly sessionRoute = computed(() => [this.item().session.role === MANAGER_ROLE ? '/manager' : '/session', this.item().session.id]);
  protected readonly ageLabel = computed(() => compactElapsedLabel(elapsedSecondsSince(this.item().updatedAt, this.now())));

  protected returnFocusToSessionLink(): void {
    this.sessionLink().nativeElement.focus();
  }
}
