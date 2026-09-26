import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

const MODEL_RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

const SWITCH_STATUS_LABEL: Record<'relaunching' | 'deferred', string> = {
  relaunching: 'restarting…',
  deferred: 'switch pending: happens when this turn ends',
};

@Component({
  selector: 'of-model-selector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="model-selector" data-testid="model-selector">
      <span class="current" data-testid="current-model">{{ session()?.model ?? 'default' }}</span>
      <select data-testid="model-select" [(ngModel)]="chosenRung">
        @for (rung of rungs; track rung) {
          <option [value]="rung">{{ rung }}</option>
        }
      </select>
      <button type="button" class="of-btn of-btn--secondary" data-testid="apply-model" [disabled]="applying()" (click)="apply()">Apply</button>
      @if (switchStatus(); as status) {
        <span class="switch-status" data-testid="model-switch-status">{{ statusLabel(status) }}</span>
      }
    </div>
  `,
  styles: `
    .model-selector { display: flex; align-items: center; gap: .375rem; }
    .current { font-family: var(--mono); font-size: .75rem; }
    .switch-status { font-size: .6875rem; color: var(--state-waiting-permission); }
  `,
})
export class ModelSelectorComponent {
  readonly sessionId = input.required<string>();
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  readonly rungs = MODEL_RUNGS;
  chosenRung: (typeof MODEL_RUNGS)[number] = 'sonnet';
  readonly applying = signal(false);
  readonly switchStatus = signal<'relaunching' | 'deferred' | null>(null);

  session() {
    return this.events.sessions().find((s) => s.id === this.sessionId());
  }

  statusLabel(status: 'relaunching' | 'deferred'): string {
    return SWITCH_STATUS_LABEL[status];
  }

  async apply(): Promise<void> {
    this.applying.set(true);
    try {
      const result = await this.api.updateModel(this.sessionId(), this.chosenRung);
      this.switchStatus.set(result.status);
    } finally {
      this.applying.set(false);
    }
  }
}
