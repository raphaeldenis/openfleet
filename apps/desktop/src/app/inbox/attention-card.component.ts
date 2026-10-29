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
    <article class="card" [class.card--blocking]="isBlocking()" data-testid="inbox-attention-card" (keydown.escape)="returnFocusToSessionLink()">
      <span class="avatar" aria-hidden="true">{{ item().session.emoji }}</span>
      <div class="body">
        <div class="meta">
          <of-kind-badge kind="question" />
          <a #sessionLink class="session-link" data-testid="inbox-attention-session" [routerLink]="sessionRoute()">{{ sessionName() }}</a>
          @if (isBlocking()) {
            <span class="blocking" title="A session is blocked until this is answered"><span class="blocking-dot" aria-hidden="true"></span>BLOCKING</span>
          }
          <span class="age" data-testid="inbox-attention-age">{{ ageLabel() }}</span>
        </div>
        @for (line of questions(); track $index) {
          <p class="line" data-testid="inbox-attention-question">{{ line }}</p>
        }
        @for (line of blockers(); track $index) {
          <p class="line line--blocker" data-testid="inbox-attention-blocker">{{ line }}</p>
        }
        <of-composer [sessionId]="item().session.id" [busy]="item().session.state === 'generating'" />
      </div>
    </article>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .card { display: flex; gap: .75rem; min-width: 0; padding: .875rem 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .avatar { display: flex; align-items: center; justify-content: center; flex: none; width: 2rem; height: 2rem; border-radius: .5rem; border: 1px solid var(--line); background: var(--sunk); }
    .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .5rem; }
    .meta { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; min-width: 0; }
    .session-link { min-width: 0; font-weight: 500; color: var(--fg); text-decoration: none; overflow-wrap: anywhere; }
    .session-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .age { margin-left: auto; font-size: .6875rem; color: var(--mut); }
    .card--blocking { border-color: color-mix(in oklch, var(--state-waiting-input) 40%, transparent); }
    .blocking { display: inline-flex; align-items: center; gap: .25rem; height: 1rem; margin-left: auto; padding: 0 .375rem; border-radius: .25rem; border: 1px solid color-mix(in oklch, var(--state-waiting-input) 45%, transparent); background: color-mix(in oklch, var(--state-waiting-input) 14%, transparent); font-family: var(--mono); font-size: .625rem; }
    .blocking-dot { width: .375rem; height: .375rem; border-radius: 50%; background: var(--state-waiting-input); }
    .blocking + .age { margin-left: 0; }
    .line { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .line--blocker { color: var(--mut); }
    of-composer { display: block; margin: 0 -.75rem; }
  `,
})
export class AttentionCardComponent {
  readonly item = input.required<AttentionItem>();
  private readonly now = tickingNow();
  private readonly sessionLink = viewChild.required<ElementRef<HTMLAnchorElement>>('sessionLink');
  protected readonly sessionName = computed(() => showInvisibleControlsAsEscapes(this.item().session.name));
  protected readonly isBlocking = computed(() => this.item().session.state === 'waiting_input');
  protected readonly questions = computed(() => this.item().questions.map(showBidiControlsAsEscapes));
  protected readonly blockers = computed(() => this.item().blockers.map(showBidiControlsAsEscapes));
  protected readonly sessionRoute = computed(() => [this.item().session.role === MANAGER_ROLE ? '/manager' : '/session', this.item().session.id]);
  protected readonly ageLabel = computed(() => compactElapsedLabel(elapsedSecondsSince(this.item().updatedAt, this.now())));

  protected returnFocusToSessionLink(): void {
    this.sessionLink().nativeElement.focus();
  }
}
