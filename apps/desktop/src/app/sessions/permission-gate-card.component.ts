import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import type { Approval } from '@openfleet/shared';
import { decideApproval } from '../core/decide-approval';
import { FleetApiService } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';

const ALWAYS_ALLOW_TOOLTIP = 'Always-allow lists for a session are a later phase feature.';

@Component({
  selector: 'of-permission-gate-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent],
  // Keeps its natural height as a flex sibling of the terminal instead of being shrunk with it.
  host: { style: 'display: block; flex: none;' },
  template: `
    <div class="gate-card" data-testid="permission-gate-card">
      <div class="gate-header">
        <span class="gate-warning" data-testid="gate-warning"><span class="gate-glyph" aria-hidden="true">!</span> Permission needed</span>
        <span class="gate-tool" data-testid="gate-tool-name">{{ approval().toolName }}</span>
      </div>
      <pre class="gate-input" data-testid="gate-tool-input">{{ formattedInput() }}</pre>
      <div class="gate-actions">
        <button type="button" class="of-btn of-btn--primary" data-testid="gate-approve" [disabled]="pending()" (click)="approve()">Approve</button>
        <button type="button" class="of-btn of-btn--secondary" data-testid="gate-deny" [disabled]="pending()" (click)="deny()">Deny</button>
        <button type="button" class="of-btn of-btn--secondary" data-testid="gate-always-allow" disabled [title]="alwaysAllowTooltip">
          Always allow for this session
        </button>
      </div>
      @if (error(); as error) {
        <of-error-line role="alert" data-testid="gate-decision-error">{{ error }}</of-error-line>
      }
    </div>
  `,
  styles: `
    .gate-card {
      display: flex; flex-direction: column; gap: .625rem; padding: .875rem 1rem;
      border: 1px solid color-mix(in oklch, var(--state-waiting-permission) 55%, transparent);
      border-radius: .5rem; background: color-mix(in oklch, var(--state-waiting-permission) 8%, var(--panel));
    }
    .gate-header { display: flex; align-items: center; gap: .5rem; }
    .gate-warning { color: var(--fg); font-weight: 600; }
    .gate-glyph { color: var(--state-waiting-permission); }
    .gate-tool { font-family: var(--mono); font-size: .75rem; padding: 0 .375rem; border-radius: .25rem; background: var(--sunk); }
    .gate-input { font-family: var(--mono); font-size: .8125rem; padding: .5rem .625rem; border-radius: .375rem; background: var(--sunk); border: 1px solid var(--line); white-space: pre-wrap; margin: 0; }
    .gate-actions { display: flex; gap: .5rem; }
  `,
})
export class PermissionGateCardComponent {
  readonly approval = input.required<Approval>();
  private readonly api = inject(FleetApiService);
  protected readonly alwaysAllowTooltip = ALWAYS_ALLOW_TOOLTIP;
  protected readonly formattedInput = computed(() => JSON.stringify(this.approval().toolInput, null, 2));
  protected readonly pending = signal(false);
  protected readonly error = signal<string | null>(null);
  private shownApprovalId: string | null = null;

  constructor() {
    // The gate card can go straight from one pending approval to the next without ever being
    // destroyed (the session stays `waiting_permission` the whole time), so a decision still in
    // flight for the previous approval must not leave the new one disabled or errored.
    effect(() => {
      const approvalId = this.approval().id;
      if (approvalId === this.shownApprovalId) return;
      this.shownApprovalId = approvalId;
      this.pending.set(false);
      this.error.set(null);
    });
  }

  approve(): void {
    void this.decide('allow');
  }

  deny(): void {
    void this.decide('deny');
  }

  private async decide(behavior: 'allow' | 'deny'): Promise<void> {
    if (this.pending()) return;
    const approvalIdAtDecision = this.approval().id;
    this.pending.set(true);
    this.error.set(null);
    const result = await decideApproval(this.api, approvalIdAtDecision, behavior);
    if (this.approval().id !== approvalIdAtDecision) return;
    if (result.outcome === 'failed') this.error.set(result.message);
    else if (result.outcome === 'already-resolved') this.error.set('Already resolved — no action taken.');
    this.pending.set(false);
  }
}
