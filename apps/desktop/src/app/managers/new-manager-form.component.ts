import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError, FleetApiService } from '../core/fleet-api.service';

const MODEL_RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
const PULSE_SECONDS_BOUNDS = { min: 1, max: 86_400 };
const CHILDREN_CAP_BOUNDS = { min: 1, max: 64 };
const MISSION_MAX_BYTES = 64 * 1024;

function isIntegerWithinBounds(value: number, bounds: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

@Component({
  selector: 'of-new-manager-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <form (ngSubmit)="submit()">
      <h3>New manager</h3>
      <input data-testid="manager-directory" name="managerDirectory" [(ngModel)]="directory" placeholder="/path/to/worktree" required />
      <input data-testid="manager-name" name="managerName" [ngModel]="name()" (ngModelChange)="name.set($event)" placeholder="Name" required />
      <input data-testid="manager-emoji" name="managerEmoji" [(ngModel)]="emoji" size="2" aria-label="Emoji" />
      <select data-testid="manager-model" name="managerModel" [(ngModel)]="model" aria-label="Model">
        @for (rung of modelRungs; track rung) {
          <option [value]="rung">{{ rung }}</option>
        }
      </select>
      <input
        data-testid="manager-pulse-seconds" name="pulseSeconds" type="number" [(ngModel)]="pulseSeconds"
        placeholder="Pulse seconds" [attr.min]="pulseSecondsBounds.min" [attr.max]="pulseSecondsBounds.max" required
      />
      @if (pulseSecondsError) {
        <span role="alert" data-testid="manager-pulse-seconds-error">{{ pulseSecondsError }}</span>
      }
      <input
        data-testid="manager-children-cap" name="childrenCap" type="number" [(ngModel)]="childrenCap"
        placeholder="Children cap" [attr.min]="childrenCapBounds.min" [attr.max]="childrenCapBounds.max" required
      />
      @if (childrenCapError) {
        <span role="alert" data-testid="manager-children-cap-error">{{ childrenCapError }}</span>
      }
      <textarea data-testid="manager-mission" name="mission" [ngModel]="mission()" (ngModelChange)="mission.set($event)" placeholder="Mission" required></textarea>
      @if (missionError) {
        <span role="alert" data-testid="manager-mission-error">{{ missionError }}</span>
      }
      <button type="submit" class="of-btn of-btn--primary" data-testid="create-manager" [disabled]="pending()">+ New manager</button>
      @if (serverError(); as error) {
        <p role="alert" data-testid="manager-form-error">{{ error }}</p>
      }
    </form>
  `,
  styles: `
    form { display: flex; flex-direction: column; gap: .4rem; padding: .6rem }
  `,
})
export class NewManagerFormComponent {
  private readonly api = inject(FleetApiService);
  protected readonly modelRungs = MODEL_RUNGS;
  protected readonly pulseSecondsBounds = PULSE_SECONDS_BOUNDS;
  protected readonly childrenCapBounds = CHILDREN_CAP_BOUNDS;
  directory = '';
  readonly name = signal('');
  emoji = '🧭';
  model: string = 'sonnet';
  pulseSeconds = 1800;
  childrenCap = 2;
  readonly mission = signal('');
  pulseSecondsError = '';
  childrenCapError = '';
  missionError = '';
  readonly serverError = signal('');
  readonly pending = signal(false);

  async submit(): Promise<void> {
    if (this.pending()) return;
    this.serverError.set('');
    if (!this.validate()) return;
    this.pending.set(true);
    try {
      await this.api.createManagerSession({
        directory: this.directory,
        name: this.name(),
        emoji: this.emoji,
        model: this.model,
        pulseSeconds: this.pulseSeconds,
        childrenCap: this.childrenCap,
        mission: this.mission(),
      });
      this.name.set('');
      this.mission.set('');
    } catch (error) {
      this.serverError.set(error instanceof ApiError ? error.message : 'Could not create the manager — check your connection');
    } finally {
      this.pending.set(false);
    }
  }

  private validate(): boolean {
    const isPulseSecondsValid = isIntegerWithinBounds(this.pulseSeconds, PULSE_SECONDS_BOUNDS);
    const isChildrenCapValid = isIntegerWithinBounds(this.childrenCap, CHILDREN_CAP_BOUNDS);
    const isMissionWithinByteLimit = utf8ByteLength(this.mission()) <= MISSION_MAX_BYTES;

    this.pulseSecondsError = isPulseSecondsValid
      ? ''
      : `Pulse seconds must be a whole number between ${PULSE_SECONDS_BOUNDS.min} and ${PULSE_SECONDS_BOUNDS.max}`;
    this.childrenCapError = isChildrenCapValid
      ? ''
      : `Children cap must be a whole number between ${CHILDREN_CAP_BOUNDS.min} and ${CHILDREN_CAP_BOUNDS.max}`;
    this.missionError = isMissionWithinByteLimit ? '' : `Mission must be at most ${MISSION_MAX_BYTES} bytes`;

    return isPulseSecondsValid && isChildrenCapValid && isMissionWithinByteLimit;
  }
}
