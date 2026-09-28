import { ChangeDetectionStrategy, Component, ElementRef, model, signal, viewChild } from '@angular/core';
import { ControlContainer, FormsModule, NgForm } from '@angular/forms';

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
  selector: 'of-manager-fields',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  viewProviders: [{ provide: ControlContainer, useExisting: NgForm }],
  template: `
    <div class="of-row">
      <div class="of-field">
        <label class="of-label" for="manager-pulse-seconds">Pulse seconds</label>
        <input
          #pulseSecondsInput id="manager-pulse-seconds" class="of-input" data-testid="manager-pulse-seconds" name="pulseSeconds" type="number"
          [ngModel]="pulseSeconds()" (ngModelChange)="onPulseSecondsChange($event)" (blur)="validatePulseSeconds()"
          placeholder="Pulse seconds" [attr.min]="pulseSecondsBounds.min" [attr.max]="pulseSecondsBounds.max"
          [attr.aria-invalid]="pulseSecondsError() ? 'true' : null"
          [attr.aria-describedby]="pulseSecondsError() ? 'manager-pulse-seconds-error' : null"
        />
        @if (pulseSecondsError(); as error) {
          <span id="manager-pulse-seconds-error" role="alert" data-testid="manager-pulse-seconds-error" class="of-error">✕ {{ error }}</span>
        }
      </div>
      <div class="of-field">
        <label class="of-label" for="manager-children-cap">Children cap</label>
        <input
          #childrenCapInput id="manager-children-cap" class="of-input" data-testid="manager-children-cap" name="childrenCap" type="number"
          [ngModel]="childrenCap()" (ngModelChange)="onChildrenCapChange($event)" (blur)="validateChildrenCap()"
          placeholder="Children cap" [attr.min]="childrenCapBounds.min" [attr.max]="childrenCapBounds.max"
          [attr.aria-invalid]="childrenCapError() ? 'true' : null"
          [attr.aria-describedby]="childrenCapError() ? 'manager-children-cap-error' : null"
        />
        @if (childrenCapError(); as error) {
          <span id="manager-children-cap-error" role="alert" data-testid="manager-children-cap-error" class="of-error">✕ {{ error }}</span>
        }
      </div>
    </div>
    <div class="of-field">
      <label class="of-label" for="manager-mission">Mission</label>
      <textarea
        #missionInput id="manager-mission" class="of-input of-input--textarea" data-testid="manager-mission" name="mission" [ngModel]="mission()"
        (ngModelChange)="mission.set($event)" placeholder="Mission" [attr.aria-invalid]="missionError() ? 'true' : null"
        [attr.aria-describedby]="missionError() ? 'manager-mission-error' : null"
      ></textarea>
      @if (missionError(); as error) {
        <span id="manager-mission-error" role="alert" data-testid="manager-mission-error" class="of-error">✕ {{ error }}</span>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 1.25rem }
    .of-row { display: flex; gap: 1rem }
    .of-row .of-field { flex: 1 }
  `,
})
export class ManagerFieldsComponent {
  protected readonly pulseSecondsBounds = PULSE_SECONDS_BOUNDS;
  protected readonly childrenCapBounds = CHILDREN_CAP_BOUNDS;
  readonly pulseSeconds = model(1800);
  readonly childrenCap = model(2);
  readonly mission = model('');
  private readonly pulseSecondsInput = viewChild<ElementRef<HTMLInputElement>>('pulseSecondsInput');
  private readonly childrenCapInput = viewChild<ElementRef<HTMLInputElement>>('childrenCapInput');
  private readonly missionInput = viewChild<ElementRef<HTMLTextAreaElement>>('missionInput');
  protected readonly pulseSecondsError = signal('');
  protected readonly childrenCapError = signal('');
  protected readonly missionError = signal('');

  validate(): boolean {
    this.validatePulseSeconds();
    this.validateChildrenCap();
    this.validateMission();
    return !this.pulseSecondsError() && !this.childrenCapError() && !this.missionError();
  }

  focusFirstInvalidField(): void {
    if (this.pulseSecondsError()) return this.pulseSecondsInput()?.nativeElement.focus();
    if (this.childrenCapError()) return this.childrenCapInput()?.nativeElement.focus();
    if (this.missionError()) return this.missionInput()?.nativeElement.focus();
  }

  protected onPulseSecondsChange(value: number): void {
    this.pulseSeconds.set(value);
    this.validatePulseSeconds();
  }

  protected onChildrenCapChange(value: number): void {
    this.childrenCap.set(value);
    this.validateChildrenCap();
  }

  protected validatePulseSeconds(): void {
    const isPulseSecondsValid = isIntegerWithinBounds(this.pulseSeconds(), PULSE_SECONDS_BOUNDS);
    this.pulseSecondsError.set(isPulseSecondsValid
      ? ''
      : `Pulse seconds must be a whole number between ${PULSE_SECONDS_BOUNDS.min} and ${PULSE_SECONDS_BOUNDS.max}`);
  }

  protected validateChildrenCap(): void {
    const isChildrenCapValid = isIntegerWithinBounds(this.childrenCap(), CHILDREN_CAP_BOUNDS);
    this.childrenCapError.set(isChildrenCapValid
      ? ''
      : `Children cap must be a whole number between ${CHILDREN_CAP_BOUNDS.min} and ${CHILDREN_CAP_BOUNDS.max}`);
  }

  private validateMission(): void {
    const isMissionMissing = this.mission().trim() === '';
    const isMissionWithinByteLimit = utf8ByteLength(this.mission()) <= MISSION_MAX_BYTES;
    if (isMissionMissing) this.missionError.set('A manager needs a mission');
    else this.missionError.set(isMissionWithinByteLimit ? '' : `Mission must be at most ${MISSION_MAX_BYTES} bytes`);
  }
}
