import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ManagerProfile, ManagerView, UpdateManager } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { ManagerFieldsComponent } from './manager-fields.component';
import { ManagerPulseProfileFieldsComponent } from './manager-pulse-profile-fields.component';

const MODEL_RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
const LIVE_MISSION_NOTE =
  'A running manager does not re-read its mission when you save it: it reads the edited mission only at its next fresh start (Reopen).';
const STALE_PROFILE_COPY = 'This profile changed since you opened it. Reload it.';
const NO_REVISION = 0;

const isSameValue = (first: unknown, second: unknown): boolean => JSON.stringify(first) === JSON.stringify(second);

/** A draft follows the stored manager until the user changes it; once changed, a newer stored manager never overwrites it. */
const draftKeptOverStoredValue = <Value>(storedValueOf: (manager: ManagerView) => Value) =>
  (manager: ManagerView, previous?: { source: ManagerView; value: Value }): Value => {
    const hasDraft = previous !== undefined && !isSameValue(previous.value, storedValueOf(previous.source));
    return hasDraft ? previous.value : storedValueOf(manager);
  };

const isStaleRevision = (error: unknown): boolean => error instanceof ApiError && error.code === 'stale_revision';

/** The always-open form for a manager's pulse, children cap, mission, expertise, pulse actions and model; saving sends only what changed. */
@Component({
  selector: 'of-manager-profile-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorLineComponent, ManagerFieldsComponent, ManagerPulseProfileFieldsComponent],
  template: `
    <form class="of-form" (ngSubmit)="save()" novalidate [attr.aria-busy]="isSaving() || null">
      <of-manager-fields [isLocked]="isSaving()" [storedMission]="manager().missionText" [(pulseSeconds)]="pulseSeconds" [(childrenCap)]="childrenCap" [(mission)]="mission" [(isMissionTouched)]="isMissionTouched" />
      <p class="note">${LIVE_MISSION_NOTE}</p>
      <of-manager-pulse-profile-fields [isLocked]="isSaving()" [expertise]="expertise()" (expertiseChange)="editExpertise($event)" [pulseActions]="pulseActions()" (pulseActionsChange)="editPulseActions($event)" />
      @if (isProfileStale()) {
        <div class="stale">
          <of-error-line role="alert">${STALE_PROFILE_COPY}</of-error-line>
          <button type="button" class="of-btn of-btn--secondary" [disabled]="isSaving()" (click)="reloadProfile()">Reload profile</button>
        </div>
      }
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
        <button type="submit" class="of-btn of-btn--primary" [disabled]="isSaving() || changedFieldCount() === 0">Save</button>
        <span class="changes" role="status" data-testid="manager-changes-count">{{ changesLabel() }}</span>
      </div>
    </form>
  `,
  styles: `
    .of-form { display: flex; flex-direction: column; gap: 1rem }
    .note { margin: 0; font-size: .75rem; color: var(--mut) }
    .model { width: auto; min-width: 10rem }
    .stale { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap }
    .actions { display: flex; align-items: center; gap: .75rem }
    .changes { font-size: .75rem; color: var(--mut) }
  `,
})
export class ManagerProfileEditorComponent {
  readonly sessionId = input.required<string>();
  readonly manager = input.required<ManagerView>();
  readonly currentModel = input<string | undefined>(undefined);
  readonly saved = output<ManagerView>();
  readonly reloaded = output<ManagerProfile>();

  private readonly api = inject(FleetApiService);
  private readonly fields = viewChild(ManagerFieldsComponent);
  private readonly pulseProfileFields = viewChild(ManagerPulseProfileFieldsComponent);

  protected readonly pulseSeconds = linkedSignal<ManagerView, number | null | undefined>({ source: this.manager, computation: draftKeptOverStoredValue<number | null | undefined>((manager) => manager.pulseSeconds) });
  protected readonly childrenCap = linkedSignal<ManagerView, number>({ source: this.manager, computation: draftKeptOverStoredValue((manager) => manager.childrenCap) });
  protected readonly mission = linkedSignal<ManagerView, string>({ source: this.manager, computation: draftKeptOverStoredValue((manager) => manager.missionText) });
  protected readonly expertise = linkedSignal<ManagerView, string>({ source: this.manager, computation: draftKeptOverStoredValue((manager) => manager.expertise ?? '') });
  protected readonly pulseActions = linkedSignal<ManagerView, string[]>({ source: this.manager, computation: draftKeptOverStoredValue((manager) => manager.pulseActions ?? []) });
  protected readonly isMissionTouched = signal(false);
  protected readonly model = linkedSignal<string | undefined, string | undefined>({ source: this.currentModel, computation: (model) => model });
  protected readonly isSaving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  // The revision of the profile the user started editing from: a newer stored revision means the manager wrote its profile meanwhile.
  private readonly revisionEditedFrom = signal<number | undefined>(undefined);
  private readonly isStaleReportedByDaemon = signal(false);
  protected readonly isProfileStale = computed(() => {
    const revisionEditedFrom = this.revisionEditedFrom();
    const isNewerRevisionStored = revisionEditedFrom !== undefined && (this.manager().profileRev ?? NO_REVISION) > revisionEditedFrom;
    return this.isStaleReportedByDaemon() || isNewerRevisionStored;
  });

  protected editExpertise(expertise: string): void {
    this.rememberRevisionEditedFrom();
    this.expertise.set(expertise);
  }

  protected editPulseActions(pulseActions: string[]): void {
    this.rememberRevisionEditedFrom();
    this.pulseActions.set(pulseActions);
  }

  private rememberRevisionEditedFrom(): void {
    const isEditStarting = this.revisionEditedFrom() === undefined;
    if (isEditStarting) this.revisionEditedFrom.set(this.manager().profileRev ?? NO_REVISION);
  }

  protected async reloadProfile(): Promise<void> {
    try {
      const reloaded = await this.api.getManagerProfile(this.sessionId());
      this.revisionEditedFrom.set(reloaded.manager.profileRev ?? NO_REVISION);
      this.isStaleReportedByDaemon.set(false);
      this.reloaded.emit(reloaded);
    } catch (error) {
      this.saveError.set(copyFor(error, { action: 'save_manager' }).text);
    }
  }

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
    const arePulseProfileFieldsValid = this.pulseProfileFields()?.validate() ?? false;
    if (!isValid || !arePulseProfileFieldsValid) {
      if (!isValid) this.fields()?.focusFirstInvalidField();
      else this.pulseProfileFields()?.focusFirstInvalidField();
      return;
    }
    const changes = this.changes();
    const hasNoChange = this.changedFieldCount() === 0;
    if (hasNoChange) return;
    this.isSaving.set(true);
    this.saveError.set(null);
    try {
      const savedManager = await this.api.updateManager(this.sessionId(), this.requestOf(changes));
      this.revisionEditedFrom.set(undefined);
      this.isStaleReportedByDaemon.set(false);
      this.saved.emit(savedManager);
    } catch (error) {
      if (isStaleRevision(error)) this.isStaleReportedByDaemon.set(true);
      else this.saveError.set(copyFor(error, { action: 'save_manager' }).text);
    } finally {
      this.isSaving.set(false);
    }
  }

  // The profile text is written against the revision the user read; a daemon that reports no revision gets none.
  private requestOf(changes: UpdateManager): UpdateManager {
    const changesProfileText = changes.expertise !== undefined || changes.pulseActions !== undefined;
    const expectedProfileRev = this.revisionEditedFrom() ?? this.manager().profileRev;
    const isRevisionKnown = expectedProfileRev !== undefined && expectedProfileRev !== NO_REVISION;
    return changesProfileText && isRevisionKnown ? { ...changes, expectedProfileRev } : changes;
  }

  private readonly changes = computed((): UpdateManager => {
    const manager = this.manager();
    const pulseSeconds = this.pulseSeconds();
    const isPulseChosen = pulseSeconds !== undefined && pulseSeconds !== null;
    const expertise = this.expertise().trim();
    const pulseActions = this.pulseActions().map((action) => action.trim());
    return {
      ...(isPulseChosen && pulseSeconds !== manager.pulseSeconds && { pulseSeconds }),
      ...(this.childrenCap() !== manager.childrenCap && { childrenCap: this.childrenCap() }),
      ...(this.mission() !== manager.missionText && { mission: this.mission() }),
      ...(expertise !== (manager.expertise ?? '') && { expertise }),
      ...(!isSameValue(pulseActions, manager.pulseActions ?? []) && { pulseActions }),
      ...(this.model() !== undefined && this.model() !== this.currentModel() && { model: this.model() }),
    };
  });

  protected readonly changedFieldCount = computed(() => Object.keys(this.changes()).length);
  protected readonly changesLabel = computed(() => (this.changedFieldCount() === 0 ? 'No changes' : `${this.changedFieldCount()} changed`));
}
