import { ChangeDetectionStrategy, Component, effect, inject, input, untracked } from '@angular/core';
import type { SessionState } from '@openfleet/shared';
import { SessionUsageService } from '../core/session-usage.service';
import { TokenUsageComponent } from '../design/token-usage.component';

/** The token usage of one session, read again whenever the session changes state: no polling. */
@Component({
  selector: 'of-session-token-usage',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TokenUsageComponent],
  template: `<of-token-usage [usage]="usage()" />`,
  styles: `:host { display: inline; }`,
})
export class SessionTokenUsageComponent {
  readonly sessionId = input.required<string>();
  readonly state = input.required<SessionState | string>();
  private readonly usages = inject(SessionUsageService);

  protected readonly usage = () => this.usages.usageOf(this.sessionId())();

  constructor() {
    effect(() => {
      const sessionId = this.sessionId();
      this.state();
      untracked(() => void this.usages.refresh(sessionId));
    });
  }
}
