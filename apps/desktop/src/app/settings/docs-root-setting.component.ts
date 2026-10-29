import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { SettingsRowComponent, type UnavailableSetting } from './settings-row.component';
import { SETTINGS_VALUE_STYLES } from './settings-value-styles';

const LOADING: UnavailableSetting = { testId: 'general-docs-root', value: '…', reason: 'Reading the setting from the daemon' };
const UNREADABLE: UnavailableSetting = { testId: 'general-docs-root', value: '—', reason: 'Not available — the daemon did not return the docs folder root' };

/** The row that shows the folder projects' docs folders are proposed under, and saves a new one. */
@Component({
  selector: 'of-docs-root-setting',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsRowComponent, ErrorLineComponent],
  template: `
    <of-settings-row name="Docs folder root" detail="Each project gets <root>/<project>/ with specs, plans, handoffs, reports" [unavailable]="unavailableSetting()">
      <div class="editor">
        <div class="controls">
          <input class="value mono" type="text" data-testid="general-docs-root" aria-label="Docs folder root" [value]="draft()" [readonly]="isSaving()" [attr.aria-invalid]="failureText() ? 'true' : null" (input)="edit($event)" (keydown.enter)="save()" />
          <button type="button" class="value" data-testid="general-docs-root-save" [attr.aria-disabled]="canSave() ? null : 'true'" (click)="save()">Save</button>
        </div>
        @if (failureText(); as text) {
          <of-error-line class="error" role="alert" data-testid="general-docs-root-error">{{ text }}</of-error-line>
        }
        @if (justSaved()) {
          <p class="hint" role="status" data-testid="general-docs-root-saved">Saved</p>
        }
      </div>
    </of-settings-row>
  `,
  styles: `
    ${SETTINGS_VALUE_STYLES}
    :host { display: block; border-bottom: 1px solid var(--line); }
    .editor { display: flex; flex-direction: column; gap: .375rem; align-items: flex-end; }
    .controls { display: flex; gap: .5rem; }
    input.value { min-width: 18rem; }
    button.value[aria-disabled='true'] { opacity: .6; cursor: not-allowed; }
  `,
})
export class DocsRootSettingComponent {
  private readonly api = inject(FleetApiService);
  private hasBeenDestroyed = false;

  private readonly loadState = signal<'loading' | 'ready' | 'unreadable'>('loading');
  private readonly savedRoot = signal('');
  protected readonly draft = signal('');
  protected readonly isSaving = signal(false);
  protected readonly failureText = signal('');
  protected readonly justSaved = signal(false);

  protected readonly unavailableSetting = computed(() => ({ loading: LOADING, unreadable: UNREADABLE, ready: undefined })[this.loadState()]);
  protected readonly canSave = computed(() => !this.isSaving() && this.draft().trim() !== '' && this.draft().trim() !== this.savedRoot());

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.hasBeenDestroyed = true));
    void this.load();
  }

  protected edit(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
    this.failureText.set('');
    this.justSaved.set(false);
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    this.isSaving.set(true);
    this.failureText.set('');
    try {
      const view = await this.api.saveDocsRoot(this.draft().trim());
      if (this.hasBeenDestroyed) return;
      this.showRoot(view);
      this.justSaved.set(true);
    } catch (error) {
      if (!this.hasBeenDestroyed) this.failureText.set(copyFor(error, { action: 'generic' }).text);
    } finally {
      this.isSaving.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      const view = await this.api.getDocsRoot();
      if (this.hasBeenDestroyed) return;
      this.showRoot(view);
      this.loadState.set('ready');
    } catch {
      if (!this.hasBeenDestroyed) this.loadState.set('unreadable');
    }
  }

  private showRoot({ root }: { root: string }): void {
    this.savedRoot.set(root);
    this.draft.set(root);
  }
}
