import { ChangeDetectionStrategy, Component, computed, ElementRef, input, model, OnInit, signal, viewChild } from '@angular/core';
import { ControlContainer, FormsModule, NgForm } from '@angular/forms';
import { isLegacyMission, isMissionWritable, MAX_CHILDREN_CAP, MAX_MISSION_DELTA_BYTES } from '@openfleet/shared';
import { ErrorLineComponent } from '../design/error-line.component';

const PULSE_SECONDS_BOUNDS = { min: 1, max: 86_400 };
const CHILDREN_CAP_BOUNDS = { min: 1, max: MAX_CHILDREN_CAP };
const BYTES_PER_KB = 1024;

interface PulsePreset {
  label: string;
  seconds: number | undefined;
}

const PULSE_PRESETS: ReadonlyArray<PulsePreset> = [
  { label: 'Daemon default', seconds: undefined },
  { label: '5 min', seconds: 300 },
  { label: '10 min', seconds: 600 },
  { label: '30 min', seconds: 1800 },
  { label: '1 h', seconds: 3600 },
];

const formatWithThousands = (bound: number) => bound.toLocaleString('en-US');

function boundedIntegerError(subject: string, value: number | null, bounds: { min: number; max: number }, unit = ''): string {
  const isWholeNumberWithinBounds = Number.isInteger(value) && value! >= bounds.min && value! <= bounds.max;
  if (isWholeNumberWithinBounds) return '';
  return `${subject} must be between ${formatWithThousands(bounds.min)} and ${formatWithThousands(bounds.max)}${unit} — enter a whole number in that range`;
}

function pulseSecondsRangeError(value: number): string {
  const isBelowMinimum = !(value >= PULSE_SECONDS_BOUNDS.min);
  if (isBelowMinimum) return 'Pulse must be at least 1 s';
  const isAboveMaximum = value > PULSE_SECONDS_BOUNDS.max;
  if (isAboveMaximum) return 'Pulse must be at most 86 400 s (24 h)';
  return boundedIntegerError('Pulse cadence', value, PULSE_SECONDS_BOUNDS, ' seconds');
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function kilobytesLabelOf(bytes: number): string {
  return (bytes / BYTES_PER_KB).toFixed(1);
}

@Component({
  selector: 'of-manager-fields',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorLineComponent],
  viewProviders: [{ provide: ControlContainer, useExisting: NgForm }],
  template: `
    <div class="of-row" [class.of-row--compact]="isCompact()" [attr.role]="isCompact() ? 'group' : null" [attr.aria-label]="isCompact() ? 'Pulse, children cap and model' : null">
      <div class="of-field">
        <label class="of-label" for="manager-pulse-seconds">Pulse cadence</label>
        @if (!isCompact()) {
          <div class="presets" role="group" aria-label="Pulse cadence presets">
            @for (preset of pulsePresets; track preset.label) {
              <button type="button" class="preset" [attr.aria-pressed]="isPresetInForce(preset)" [attr.aria-disabled]="isLocked() ? 'true' : null" (click)="choosePreset(preset)">{{ preset.label }}</button>
            }
          </div>
        }
        <div class="custom">
          <input
            #pulseSecondsInput id="manager-pulse-seconds" class="of-input pulse-input" data-testid="manager-pulse-seconds" name="pulseSeconds" type="number" [readonly]="isLocked()"
            [ngModel]="pulseSeconds()" (ngModelChange)="pulseSeconds.set($event)" (input)="onPulseTyped(pulseSecondsInput)"
            placeholder="Daemon default" [attr.min]="pulseSecondsBounds.min" [attr.max]="pulseSecondsBounds.max"
            [attr.aria-invalid]="pulseSecondsError() ? 'true' : null"
            [attr.aria-describedby]="pulseSecondsError() ? 'manager-pulse-seconds-bounds manager-pulse-seconds-error' : 'manager-pulse-seconds-bounds'"
          />
          <span id="manager-pulse-seconds-bounds" class="hint">seconds · 1 – 86,400</span>
        </div>
        @if (pulseSecondsError(); as error) {
          <of-error-line id="manager-pulse-seconds-error" role="alert" data-testid="manager-pulse-seconds-error">{{ error }}</of-error-line>
        }
      </div>
      <div class="of-field">
        <label class="of-label" for="manager-children-cap">Children cap</label>
        <div class="stepper">
          <button type="button" class="step" data-testid="manager-children-cap-decrease" aria-label="Decrease children cap" title="Decrease" [disabled]="isChildrenCapAtMinimum() || isLocked()" (click)="stepChildrenCap(-1)">−</button>
          <input
            #childrenCapInput id="manager-children-cap" class="of-input cap-input" data-testid="manager-children-cap" name="childrenCap" type="number" [readonly]="isLocked()"
            [ngModel]="childrenCap()" (ngModelChange)="childrenCap.set($event)"
            placeholder="Children cap" [attr.min]="childrenCapBounds.min" [attr.max]="childrenCapBounds.max"
            [attr.aria-invalid]="childrenCapError() ? 'true' : null"
            [attr.aria-describedby]="childrenCapDescriptionIds()"
          />
          <button type="button" class="step" data-testid="manager-children-cap-increase" aria-label="Increase children cap" title="Increase" [disabled]="isChildrenCapAtMaximum() || isLocked()" (click)="stepChildrenCap(1)">+</button>
          <span id="manager-children-cap-bounds" class="hint">{{ childrenCapBounds.min }} – {{ childrenCapBounds.max }}</span>
        </div>
        @if (isChildrenCapAtMaximum() && !childrenCapError()) {
          <span id="manager-children-cap-maximum" role="status" data-testid="manager-children-cap-maximum" class="maximum"><span class="maximum-icon" aria-hidden="true">!</span> {{ childrenCapBounds.max }} is the daemon maximum</span>
        }
        @if (childrenCapError(); as error) {
          <of-error-line id="manager-children-cap-error" role="alert" data-testid="manager-children-cap-error">{{ error }}</of-error-line>
        }
      </div>
      <ng-content select="[rowEnd]" />
    </div>
    <div class="of-field">
      <label class="of-label" for="manager-mission">Mission</label>
      <textarea
        #missionInput id="manager-mission" class="of-input of-input--textarea" data-testid="manager-mission" name="mission" [readonly]="isLocked()" [ngModel]="mission()"
        (ngModelChange)="onMissionChange($event)" placeholder="Mission" [attr.aria-invalid]="missionError() ? 'true' : null"
        [attr.aria-describedby]="missionDescriptionIds() || null"
      ></textarea>
      <span id="manager-mission-size" class="hint mission-size" data-testid="manager-mission-size">{{ missionSizeLabel() }}</span>
      @if (showsLegacyBanner()) {
        <span id="manager-mission-legacy" role="status" data-testid="manager-mission-legacy" class="maximum"><span class="maximum-icon" aria-hidden="true">!</span> Legacy mission: reduce it to the delta</span>
      }
      @if (missionError(); as error) {
        <of-error-line id="manager-mission-error" role="alert" data-testid="manager-mission-error">{{ error }}</of-error-line>
      }
    </div>
    @if (offersAttended()) {
      <div class="of-field">
        <label class="attended-label" for="manager-attended">
          <input
            id="manager-attended" type="checkbox" data-testid="manager-attended" name="attended" [disabled]="isLocked()"
            [ngModel]="isAttended()" (ngModelChange)="isAttended.set($event)" aria-describedby="manager-attended-hint"
          />
          I sit beside this manager and answer its questions myself
        </label>
        <span id="manager-attended-hint" class="hint hint--wrap" data-testid="manager-attended-hint">Leave this unticked for a manager that works without you: it raises its questions through the escalation ladder and is refused AskUserQuestion. The choice cannot be changed once the manager exists.</span>
      </div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 1.25rem }
    .of-row { display: flex; gap: 1rem }
    .of-row .of-field { flex: 1 }
    .of-row--compact { flex-wrap: wrap; align-items: flex-start }
    .of-row--compact .of-field { flex: 1 1 11rem }
    .presets { display: flex; flex-wrap: wrap; gap: .25rem }
    .preset { flex: 1 1 3rem; height: 2rem; padding: 0 .375rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--panel); color: var(--fg); font: inherit; font-size: .75rem; white-space: nowrap; cursor: pointer }
    .preset[aria-pressed='true'] { border-color: var(--accent); background: var(--accent-bg) }
    .preset[aria-disabled='true'] { cursor: not-allowed }
    .preset:focus-visible, .step:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .custom, .stepper { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem }
    .pulse-input { flex: none; width: 9rem; font-family: var(--mono); font-size: .75rem }
    .cap-input { flex: none; width: 4rem; text-align: center; font-family: var(--mono); appearance: textfield; -moz-appearance: textfield }
    .cap-input::-webkit-inner-spin-button, .cap-input::-webkit-outer-spin-button { appearance: none; margin: 0 }
    .step { flex: none; width: 2rem; height: 2rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--panel); color: var(--fg); font: inherit; cursor: pointer }
    .step:disabled { color: var(--mut); cursor: not-allowed }
    .hint { font-size: .6875rem; color: var(--mut); white-space: nowrap }
    .attended-label { display: flex; align-items: center; gap: .5rem; font-size: .875rem; cursor: pointer }
    .hint--wrap { display: block; white-space: normal }
    .mission-size { align-self: flex-end }
    .maximum { font-size: .75rem; color: var(--fg) }
    .maximum-icon { font-weight: 700; color: var(--state-waiting-permission) }
  `,
})
export class ManagerFieldsComponent implements OnInit {
  protected readonly pulseSecondsBounds = PULSE_SECONDS_BOUNDS;
  protected readonly childrenCapBounds = CHILDREN_CAP_BOUNDS;
  protected readonly pulsePresets = PULSE_PRESETS;
  readonly isLocked = input(false);
  /** Lays pulse, children cap and a projected `rowEnd` field on one row, without the cadence presets. */
  readonly isCompact = input(false);
  // Undefined or null (typed then cleared): the daemon applies its own heartbeat default.
  readonly pulseSeconds = model<number | null | undefined>(undefined);
  readonly childrenCap = model(2);
  readonly mission = model('');
  readonly isMissionTouched = model(false);
  /** Only the creation form offers the choice: the flag is fixed once the manager exists. */
  readonly offersAttended = input(false);
  readonly isAttended = model(false);
  /** The mission as the daemon stores it: a stored mission above the delta limit may shrink, never grow. Absent for a new manager. */
  readonly storedMission = input<string | undefined>(undefined);
  private readonly pulseSecondsInput = viewChild<ElementRef<HTMLInputElement>>('pulseSecondsInput');
  private readonly childrenCapInput = viewChild<ElementRef<HTMLInputElement>>('childrenCapInput');
  private readonly missionInput = viewChild<ElementRef<HTMLTextAreaElement>>('missionInput');
  private readonly isPulseTextUnreadable = signal(false);
  private readonly isPulseLeftToDaemonDefault = computed(() => this.pulseSeconds() === undefined || this.pulseSeconds() === null);
  protected readonly pulseSecondsError = computed(() => {
    if (this.isPulseTextUnreadable()) return pulseSecondsRangeError(NaN);
    return this.isPulseLeftToDaemonDefault() ? '' : pulseSecondsRangeError(this.pulseSeconds()!);
  });
  protected readonly childrenCapError = computed(() => boundedIntegerError('Children cap', this.childrenCap(), CHILDREN_CAP_BOUNDS));
  protected readonly isChildrenCapAtMinimum = computed(() => this.childrenCap() <= CHILDREN_CAP_BOUNDS.min);
  protected readonly isChildrenCapAtMaximum = computed(() => this.childrenCap() >= CHILDREN_CAP_BOUNDS.max);
  protected readonly childrenCapDescriptionIds = computed(() => {
    const showsMaximumNote = this.isChildrenCapAtMaximum() && !this.childrenCapError();
    return ['manager-children-cap-bounds', showsMaximumNote ? 'manager-children-cap-maximum' : '', this.childrenCapError() ? 'manager-children-cap-error' : ''].filter(Boolean).join(' ');
  });
  readonly hasInvalidNumbers = computed(() => this.pulseSecondsError() !== '' || this.childrenCapError() !== '');
  protected readonly missionError = signal('');
  protected readonly isStoredMissionLegacy = computed(() => this.storedMission() !== undefined && isLegacyMission(this.storedMission()!));
  protected readonly showsLegacyBanner = computed(() => this.isStoredMissionLegacy() && isLegacyMission(this.mission()));
  protected readonly missionSizeLabel = computed(() => `${kilobytesLabelOf(utf8ByteLength(this.mission()))} / ${MAX_MISSION_DELTA_BYTES / BYTES_PER_KB} KB`);
  protected readonly missionDescriptionIds = computed(() => [this.showsLegacyBanner() ? 'manager-mission-legacy' : '', this.missionError() ? 'manager-mission-error' : ''].filter(Boolean).join(' '));

  ngOnInit(): void {
    if (this.isMissionTouched()) this.validateMission();
  }

  validate(): boolean {
    this.isMissionTouched.set(true);
    this.validateMission();
    return !this.hasInvalidNumbers() && !this.missionError();
  }

  focusFirstInvalidField(): void {
    if (this.pulseSecondsError()) return this.pulseSecondsInput()?.nativeElement.focus();
    if (this.childrenCapError()) return this.childrenCapInput()?.nativeElement.focus();
    if (this.missionError()) return this.missionInput()?.nativeElement.focus();
  }

  protected isPresetInForce(preset: PulsePreset): boolean {
    return preset.seconds === undefined ? this.isPulseLeftToDaemonDefault() : this.pulseSeconds() === preset.seconds;
  }

  protected choosePreset(preset: PulsePreset): void {
    if (this.isLocked()) return;
    this.isPulseTextUnreadable.set(false);
    const pulseInput = this.pulseSecondsInput()?.nativeElement;
    if (pulseInput) pulseInput.value = '';
    this.pulseSeconds.set(preset.seconds);
  }

  protected onPulseTyped(pulseInput: HTMLInputElement): void {
    this.isPulseTextUnreadable.set(pulseInput.validity.badInput);
  }

  protected stepChildrenCap(direction: 1 | -1): void {
    const current = this.childrenCap();
    const currentWholeNumber = Number.isFinite(current) ? Math.round(current) : 0;
    const stepped = currentWholeNumber + direction;
    this.childrenCap.set(Math.min(CHILDREN_CAP_BOUNDS.max, Math.max(CHILDREN_CAP_BOUNDS.min, stepped)));
  }

  protected onMissionChange(value: string): void {
    this.mission.set(value);
    this.isMissionTouched.set(true);
    this.validateMission();
  }

  private validateMission(): void {
    const isMissionMissing = this.mission().trim() === '';
    if (isMissionMissing) return this.missionError.set('A manager needs a mission');
    const isMissionWritableAsIs = isMissionWritable({ mission: this.mission(), storedMission: this.storedMission() });
    if (isMissionWritableAsIs) return this.missionError.set('');
    const growsALegacyMission = this.isStoredMissionLegacy();
    this.missionError.set(growsALegacyMission
      ? `A legacy mission can only shrink: keep it at ${kilobytesLabelOf(utf8ByteLength(this.storedMission()!))} KB or less`
      : `Mission must be at most ${MAX_MISSION_DELTA_BYTES / BYTES_PER_KB} KB`);
  }
}
