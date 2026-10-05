import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { ManagerProfile, ManagerView, ScapeImportStatus, Session } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { compactElapsedLabel } from '../design/elapsed-time';
import { MarkdownViewComponent } from '../notes/markdown-view.component';
import { ManagerProfileEditorComponent } from './manager-profile-editor.component';

type LoadStatus = 'loading' | 'failed' | 'ready';

const PROFILE_LOAD_FAILED = "Couldn't load this manager's profile.";
const NOT_KNOWN = '—';

const IMPORT_LINE_BY_STATUS: Record<ScapeImportStatus, string | undefined> = {
  not_imported: undefined,
  as_imported: 'Imported from Scape and not edited here — a re-import can update it.',
  edited_in_openfleet: 'Edited here — a Scape re-import will not overwrite it.',
};

/** What a manager is: its facts, its mission as read-only text, and the always-open form that edits them. */
@Component({
  selector: 'of-manager-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, ManagerProfileEditorComponent, MarkdownViewComponent],
  template: `
    @switch (status()) {
      @case ('loading') {
        <p class="note" role="status">Loading the manager profile…</p>
      }
      @case ('failed') {
        <div class="note">
          <of-error-line role="alert">${PROFILE_LOAD_FAILED}</of-error-line>
          <button type="button" class="of-btn of-btn--secondary" (click)="load()">Retry</button>
        </div>
      }
      @case ('ready') {
        @if (profile(); as current) {
          <section aria-label="Profile">
            <dl class="facts">
              <div class="fact"><dt>Pulse interval</dt><dd>{{ pulseLabel() }}</dd></div>
              <div class="fact"><dt>Children cap</dt><dd>{{ current.manager.childrenCap }}</dd></div>
              <div class="fact"><dt>Model</dt><dd>{{ session().model || notKnown }}</dd></div>
            </dl>
          </section>

          <section class="card" aria-labelledby="manager-mission-title">
            <div class="card-head">
              <h2 id="manager-mission-title" class="card-title">Mission</h2>
              <span class="card-hint">read-only · Markdown</span>
            </div>
            <div class="card-body">
              @if (current.manager.missionText.trim() === '') {
                <p class="note">No mission written yet.</p>
              } @else {
                <of-markdown-view [markdown]="current.manager.missionText" />
              }
              @if (importLine(); as line) {
                <p class="note origin"><span aria-hidden="true">✎</span> {{ line }}</p>
              }
            </div>
          </section>

          <section class="card" aria-labelledby="manager-edit-title">
            <div class="card-head">
              <h2 id="manager-edit-title" class="card-title">Edit</h2>
              <span class="card-hint">only changed fields are sent</span>
            </div>
            <div class="card-body">
              <of-manager-profile-editor [sessionId]="session().id" [manager]="current.manager" [currentModel]="session().model" (saved)="applySaved($event)" />
            </div>
          </section>
        }
      }
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 1rem; margin: 0 1.25rem 1.25rem }
    .note { margin: 0; font-size: .75rem; color: var(--mut); display: flex; align-items: center; gap: .5rem }
    .origin { margin-top: .75rem }
    .card { border: 1px solid var(--line); border-radius: .625rem; background: var(--panel) }
    .card-head { display: flex; align-items: center; gap: .5rem; padding: .625rem .875rem }
    .card-title { margin: 0; flex: 1; font-size: .875rem; font-weight: 600 }
    .card-hint { font-size: .6875rem; color: var(--mut) }
    .card-body { padding: .75rem .875rem; border-top: 1px solid var(--line) }
    .facts { display: flex; flex-wrap: wrap; gap: .75rem; margin: 0 }
    .fact { flex: 1 1 9rem; display: flex; flex-direction: column; gap: .25rem; padding: .625rem .875rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel) }
    .fact dt { font-size: .6875rem; color: var(--mut) }
    .fact dd { margin: 0; font-family: var(--mono); font-size: 1rem; overflow-wrap: anywhere }
  `,
})
export class ManagerProfileComponent {
  readonly session = input.required<Session>();

  private readonly api = inject(FleetApiService);

  protected readonly notKnown = NOT_KNOWN;
  protected readonly status = signal<LoadStatus>('loading');
  protected readonly profile = signal<ManagerProfile | undefined>(undefined);

  protected readonly importLine = computed(() => IMPORT_LINE_BY_STATUS[this.profile()?.scapeImport ?? 'not_imported']);
  protected readonly pulseLabel = computed(() => {
    const pulseSeconds = this.profile()?.manager.pulseSeconds;
    return pulseSeconds === undefined ? NOT_KNOWN : compactElapsedLabel(pulseSeconds);
  });

  private readonly sessionId = computed(() => this.session().id);

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => void this.load());
    });
  }

  protected async load(): Promise<void> {
    const sessionId = this.sessionId();
    this.status.set('loading');
    try {
      const loaded = await this.api.getManagerProfile(sessionId);
      const isStillShown = this.sessionId() === sessionId;
      if (!isStillShown) return;
      this.profile.set(loaded);
      this.status.set('ready');
    } catch {
      const isStillShown = this.sessionId() === sessionId;
      if (isStillShown) this.status.set('failed');
    }
  }

  protected async applySaved(saved: ManagerView): Promise<void> {
    this.profile.update((current) => current && { ...current, manager: saved });
    await this.refreshProfileQuietly();
  }

  private async refreshProfileQuietly(): Promise<void> {
    const sessionId = this.sessionId();
    try {
      const refreshed = await this.api.getManagerProfile(sessionId);
      if (this.sessionId() === sessionId) this.profile.set(refreshed);
    } catch {
      // The saved values are already shown; the import line catches up at the next load.
    }
  }
}
