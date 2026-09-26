import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { Approval } from '@openfleet/shared';
import { decideApproval } from '../core/decide-approval';
import { FleetApiService } from '../core/fleet-api.service';

const ALWAYS_ALLOW_TOOLTIP = 'Always-allow lists for a session are a later phase feature.';

@Component({
  selector: 'of-permission-gate-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gate-card" data-testid="permission-gate-card">
      <div class="gate-header">
        <span class="gate-warning">! Permission needed</span>
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
        <span role="alert" data-testid="gate-decision-error" class="of-error">✕ {{ error }}</span>
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
    .gate-warning { color: var(--state-waiting-permission); font-weight: 600; }
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

  approve(): void {
    void this.decide('allow');
  }

  deny(): void {
    void this.decide('deny');
  }

  private async decide(behavior: 'allow' | 'deny'): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    this.error.set(null);
    const result = await decideApproval(this.api, this.approval().id, behavior);
    if (result.outcome === 'failed') this.error.set(result.message);
    else if (result.outcome === 'already-resolved') this.error.set('Already resolved — no action taken.');
    this.pending.set(false);
  }
}
