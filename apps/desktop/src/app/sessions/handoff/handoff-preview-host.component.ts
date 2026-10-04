import { ChangeDetectionStrategy, Component, effect, inject, input, output, untracked } from '@angular/core';
import { FleetApiService } from '../../core/fleet-api.service';
import { createHandoffPreviewApi } from './handoff-preview.adapter';
import { HandoffPreviewStore } from './handoff-preview.store';
import { HandoffPreviewPanelComponent, type HandoffPanelDensity, type HandoffSubject } from './handoff-preview-panel.component';

export const HANDOFF_PREVIEW_META_TEXT = 'From the state panel and git status · edit before saving';

/** One handoff preview of one session: collects the draft when shown, and asks its host to hide it on Cancel, Escape or after the save. */
@Component({
  selector: 'of-handoff-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HandoffPreviewPanelComponent],
  template: `
    <of-handoff-preview-panel
      [state]="store.state()"
      [relativePath]="store.relativePath()"
      [sections]="store.sections()"
      [sources]="store.sources()"
      [metaText]="metaText"
      [error]="store.error()"
      [saveDisabledReason]="store.saveDisabledReason()"
      [density]="density()"
      [subject]="subject()"
      (sectionsChange)="store.edit($event)"
      (save)="store.save()"
      (retry)="store.retry()"
      (cancel)="dismissed.emit()"
      (autoClose)="dismissed.emit()"
    />
    @if (targetAvailableHint(); as hint) {
      @if (store.isTargetAvailable()) {
        <p class="hint" data-testid="handoff-target-hint">{{ hint }}</p>
      }
    }
  `,
  styles: `
    .hint { margin: 0; padding: 0 1.25rem .75rem; color: var(--mut); font-size: .75rem; background: var(--sunk); border-bottom: 1px solid var(--line); }
  `,
})
export class HandoffPreviewHostComponent {
  readonly sessionId = input.required<string>();
  readonly density = input<HandoffPanelDensity>('compact');
  readonly subject = input<HandoffSubject>('session');
  /** Shown under the panel while the target can receive the handoff. */
  readonly targetAvailableHint = input<string>();
  readonly dismissed = output<void>();

  protected readonly metaText = HANDOFF_PREVIEW_META_TEXT;
  protected readonly store = new HandoffPreviewStore(createHandoffPreviewApi(inject(FleetApiService)));

  constructor() {
    effect(() => {
      const sessionId = this.sessionId();
      untracked(() => void this.store.open(sessionId));
    });
  }
}
