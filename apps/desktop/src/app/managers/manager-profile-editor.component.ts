import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ManagerView, UpdateManager } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { ManagerFieldsComponent } from './manager-fields.component';

const MODEL_RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
const LIVE_MISSION_NOTE =
  'A running manager does not re-read its mission when you save it: it reads the edited mission only at its next fresh start (Reopen).';

/** What the user edits of a manager: its pulse, children cap, mission and model; saving sends only what changed. */
@Component({
  selector: 'of-manager-profile-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorLineComponent, ManagerFieldsComponent],
  template: `
    <form class="of-form" (ngSubmit)="save()" novalidate [attr.aria-busy]="isSaving() || null">
      <of-manager-fields [isLocked]="isSaving()" [(pulseSeconds)]="pulseSeconds" [(childrenCap)]="childrenCap" [(mission)]="mission" [(isMissionTouched)]="isMissionTouched" />
      <p class="note">${LIVE_MISSION_NOTE}</p>
      <div class="of-field">
        <label class="of-label" for="manager-model">Model</label>
        <select id="manager-model" class="of-input model" [disabled]="isSaving()" (change)="chooseModel($event)">
          @for (rung of modelChoices(); track rung) {
            <option [value]="rung" [selected]="rung === model()">{{ rung }}</option>
          }
        </select>
      </div>
      @if (saveError(); as error) {
        <of-error-line role="alert">{{ error }}</of-error-line>
      }
      <div class="actions">
        <button type="submit" class="of-btn of-btn--primary" [disabled]="isSaving()">Save</button>
        <button type="button" class="of-btn of-btn--secondary" [disabled]="isSaving()" (click)="cancelled.emit()">Cancel</button>
      </div>
    </form>
  `,
  styles: `
    .of-form { display: flex; flex-direction: column; gap: 1rem }
    .note { margin: 0; font-size: .75rem; color: var(--mut) }
    .model { width: auto; min-width: 10rem }
    .actions { display: flex; gap: .5rem }
  `,
})
export class ManagerProfileEditorComponent {
  readonly sessionId = input.required<string>();
  readonly manager = input.required<ManagerView>();
  readonly currentModel = input<string | undefined>(undefined);
  readonly saved = output<ManagerView>();
  readonly cancelled = output<void>();

  private readonly api = inject(FleetApiService);
  private readonly fields = viewChild(ManagerFieldsComponent);

  protected readonly pulseSeconds = linkedSignal<ManagerView, number | null | undefined>({ source: this.manager, computation: (manager) => manager.pulseSeconds });
  protected readonly childrenCap = linkedSignal<ManagerView, number>({ source: this.manager, computation: (manager) => manager.childrenCap });
  protected readonly mission = linkedSignal<ManagerView, string>({ source: this.manager, computation: (manager) => manager.missionText });
  protected readonly isMissionTouched = signal(false);
  protected readonly model = linkedSignal<string | undefined, string | undefined>({ source: this.currentModel, computation: (model) => model });
  protected readonly isSaving = signal(false);
  protected readonly saveError = signal<string | null>(null);

  protected readonly modelChoices = computed((): readonly string[] => {
    const model = this.currentModel();
    const isExactModelId = model !== undefined && !(MODEL_RUNGS as readonly string[]).includes(model);
    return isExactModelId ? [...MODEL_RUNGS, model] : MODEL_RUNGS;
  });

  protected chooseModel(event: Event): void {
    this.model.set((event.target as HTMLSelectElement).value);
  }

  protected async save(): Promise<void> {
    if (this.isSaving()) return;
    const isValid = this.fields()?.validate() ?? false;
    if (!isValid) {
      this.fields()?.focusFirstInvalidField();
      return;
    }
    const changes = this.changes();
    const hasNoChange = Object.keys(changes).length === 0;
    if (hasNoChange) {
      this.cancelled.emit();
      return;
    }
    this.isSaving.set(true);
    this.saveError.set(null);
    try {
      this.saved.emit(await this.api.updateManager(this.sessionId(), changes));
    } catch (error) {
      this.saveError.set(copyFor(error, { action: 'save_manager' }).text);
    } finally {
      this.isSaving.set(false);
    }
  }

  private changes(): UpdateManager {
    const manager = this.manager();
    const pulseSeconds = this.pulseSeconds();
    const isPulseChosen = pulseSeconds !== undefined && pulseSeconds !== null;
    return {
      ...(isPulseChosen && pulseSeconds !== manager.pulseSeconds && { pulseSeconds }),
      ...(this.childrenCap() !== manager.childrenCap && { childrenCap: this.childrenCap() }),
      ...(this.mission() !== manager.missionText && { mission: this.mission() }),
      ...(this.model() !== undefined && this.model() !== this.currentModel() && { model: this.model() }),
    };
  }
}
