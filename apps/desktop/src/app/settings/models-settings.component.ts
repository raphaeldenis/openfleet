import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ErrorLineComponent } from '../design/error-line.component';
import { moveFocusWithinListbox } from '../design/listbox-keyboard';
import { PopoverComponent } from '../design/popover.component';
import { MODEL_RUNGS, type ModelChange, ModelRungsState } from './model-rungs.state';
import { SettingsRowComponent } from './settings-row.component';
import { SettingsSectionComponent } from './settings-section.component';
import { SETTINGS_VALUE_STYLES } from './settings-value-styles';

const NO_MODEL_ID_LABEL = '—';

@Component({
  selector: 'of-models-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, SettingsSectionComponent, SettingsRowComponent, PopoverComponent],
  template: `
    <of-settings-section heading="Models" testId="settings-models">
      @if (state.hasFailedToLoad()) {
        <p class="error" role="alert" data-testid="models-error"><of-error-line>Couldn’t load the model table from the daemon.</of-error-line></p>
      } @else if (state.modelTable()) {
        <div class="rows">
          @for (row of rungs; track row.rung) {
            <of-settings-row [attr.data-testid]="'model-row-' + row.rung" [name]="row.rung" [detail]="row.description">
              <of-popover
                #popover
                [triggerTestId]="'model-trigger-' + row.rung"
                [triggerLabel]="row.rung + ' model: ' + labelOfDisplayedId(row.rung)"
                width="19rem"
                [disabled]="state.isSaving()"
              >
                <span popoverTrigger class="id">{{ labelOfDisplayedId(row.rung) }}</span>
                <ng-template>
                  <div role="listbox" [attr.aria-label]="row.rung + ' model id'" #listbox (keydown)="moveFocusWithinListbox($event, listbox)">
                    @for (modelId of state.optionIdsByRung()[row.rung]; track modelId) {
                      <button
                        type="button"
                        role="option"
                        class="option"
                        [attr.aria-selected]="modelId === state.displayedIdOf(row.rung)"
                        [attr.tabindex]="modelId === state.displayedIdOf(row.rung) ? 0 : -1"
                        [attr.data-initial-focus]="modelId === state.displayedIdOf(row.rung) ? '' : null"
                        (click)="choose({ rung: row.rung, modelId }, popover)"
                      >
                        <span class="option-id">{{ modelId }}</span>
                        <span class="check" aria-hidden="true">{{ modelId === state.displayedIdOf(row.rung) ? '✓' : '' }}</span>
                      </button>
                    }
                  </div>
                </ng-template>
              </of-popover>
            </of-settings-row>
          }
        </div>
        <p class="hint status" role="status" data-testid="models-save-status">{{ state.saveStatusMessage() }}</p>
        @if (failedSave(); as failure) {
          <div class="error-card" role="alert" data-testid="models-save-error">
            <div class="error-text">
              <of-error-line class="error-title">Couldn’t save {{ failure.change.rung }}</of-error-line>
              <span class="detail">{{ failure.cause }}</span>
            </div>
            <button type="button" class="of-btn of-btn--secondary" (click)="state.retry(failure.change)">Retry</button>
          </div>
        }
        <p class="hint" data-testid="models-edit-hint">A change applies to new sessions · running sessions keep their model</p>
      } @else {
        <div class="loading" data-testid="models-loading" role="status" aria-busy="true" aria-label="Loading models">
          @for (placeholder of loadingPlaceholders; track placeholder) {
            <div class="skeleton"></div>
          }
        </div>
      }
    </of-settings-section>
  `,
  styles: `
    ${SETTINGS_VALUE_STYLES}
    .id { font-size: .75rem; }
    .status:empty { position: absolute; }
    .detail { font-size: .75rem; color: var(--mut); }
    .option { display: flex; align-items: center; gap: .5rem; width: 100%; height: 1.875rem; padding: 0 .5rem; border: 0; border-radius: .375rem; background: transparent; color: var(--fg); font-family: var(--mono); font-size: .75rem; text-align: left; cursor: pointer; }
    .option:hover, .option[aria-selected='true'] { background: var(--hover); }
    .option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .option-id { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .check { color: var(--accent); }
    .loading { display: flex; flex-direction: column; gap: .5rem; }
    .skeleton { height: 3rem; border-radius: .5rem; background: var(--sunk); }
    .error-card { display: flex; align-items: center; gap: 1rem; padding: .75rem 1rem; border: 1px solid var(--state-error); border-radius: .625rem; background: var(--panel); }
    .error-text { flex: 1; display: flex; flex-direction: column; }
    .error-title { font-weight: 500; }
  `,
})
export class ModelsSettingsComponent {
  protected readonly state = inject(ModelRungsState);
  protected readonly rungs = MODEL_RUNGS;
  protected readonly loadingPlaceholders = [1, 2, 3, 4];
  protected readonly moveFocusWithinListbox = moveFocusWithinListbox;

  protected failedSave() {
    const saveState = this.state.saveState();
    return saveState.kind === 'failed' ? saveState : null;
  }

  protected labelOfDisplayedId(rung: string): string {
    return this.state.displayedIdOf(rung) || NO_MODEL_ID_LABEL;
  }

  protected choose(change: ModelChange, popover: PopoverComponent): void {
    popover.close();
    void this.state.choose(change);
  }
}
