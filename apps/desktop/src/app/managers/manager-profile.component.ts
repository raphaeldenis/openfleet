import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { ManagerProfile, ManagerView, Page, Project, ScapeImportStatus, Session } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { compactElapsedLabel, elapsedSecondsSince } from '../design/elapsed-time';
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

/** What a manager is: its facts, its mission as read-only text, and the form that edits them. */
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
          <section class="card" aria-labelledby="manager-profile-title">
            <h2 id="manager-profile-title" class="card-title">Profile</h2>
            <dl class="facts">
              <div class="fact"><dt>Project</dt><dd>{{ projectName() }}</dd></div>
              <div class="fact"><dt>Harness</dt><dd>{{ session().harness }}</dd></div>
              <div class="fact"><dt>Model</dt><dd>{{ session().model || notKnown }}</dd></div>
              <div class="fact"><dt>Pulse</dt><dd>{{ pulseLabel() }}</dd></div>
              <div class="fact"><dt>Children cap</dt><dd>{{ current.manager.childrenCap }}</dd></div>
              <div class="fact"><dt>Last activity</dt><dd>{{ lastActivityLabel() }}</dd></div>
            </dl>
          </section>

          <section class="card" aria-labelledby="manager-mission-title">
            <div class="card-head">
              <h2 id="manager-mission-title" class="card-title">Mission</h2>
              @if (!isEditing()) {
                <button type="button" class="of-btn of-btn--secondary of-btn--compact" (click)="isEditing.set(true)">Edit</button>
              }
            </div>
            @if (importLine(); as line) {
              <p class="note">{{ line }}</p>
            }
            <div class="card-body">
              @if (isEditing()) {
                <of-manager-profile-editor
                  [sessionId]="session().id" [manager]="current.manager" [currentModel]="session().model"
                  (saved)="finishEditing($event)" (cancelled)="isEditing.set(false)"
                />
              } @else if (current.manager.missionText.trim() === '') {
                <p class="note">No mission written yet.</p>
              } @else {
                <of-markdown-view [markdown]="current.manager.missionText" />
              }
            </div>
          </section>
        }
      }
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 1rem; margin: 0 1.25rem 1.25rem }
    .note { margin: 0; font-size: .75rem; color: var(--mut); display: flex; align-items: center; gap: .5rem }
    .card { border: 1px solid var(--line); border-radius: .625rem; background: var(--panel) }
    .card-head { display: flex; align-items: center; gap: .5rem; padding-right: .875rem }
    .card-title { margin: 0; flex: 1; font-size: .875rem; font-weight: 600; padding: .625rem .875rem 0 }
    .card-head .card-title { padding-bottom: .625rem }
    .card > .note { padding: 0 .875rem .5rem }
    .card-body { padding: .75rem .875rem; border-top: 1px solid var(--line) }
    .facts { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0; padding: .625rem .875rem .875rem }
    .fact { flex: 1 1 9rem; display: flex; flex-direction: column; gap: .25rem; padding: .5rem .625rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--sunk) }
    .fact dt { font-size: .6875rem; color: var(--mut) }
    .fact dd { margin: 0; font-family: var(--mono); font-size: .8125rem; overflow-wrap: anywhere }
  `,
})
export class ManagerProfileComponent {
  readonly session = input.required<Session>();

  private readonly api = inject(FleetApiService);
  private readonly now = signal(Date.now());

  protected readonly notKnown = NOT_KNOWN;
  protected readonly status = signal<LoadStatus>('loading');
  protected readonly profile = signal<ManagerProfile | undefined>(undefined);
  protected readonly projects = signal<readonly Project[]>([]);
  protected readonly isEditing = signal(false);

  protected readonly projectName = computed(() => this.projects().find((project) => project.id === this.session().projectId)?.name ?? NOT_KNOWN);
  protected readonly importLine = computed(() => IMPORT_LINE_BY_STATUS[this.profile()?.scapeImport ?? 'not_imported']);
  protected readonly pulseLabel = computed(() => {
    const pulseSeconds = this.profile()?.manager.pulseSeconds;
    return pulseSeconds === undefined ? NOT_KNOWN : `every ${compactElapsedLabel(pulseSeconds)}`;
  });
  protected readonly lastActivityLabel = computed(() => {
    const elapsed = compactElapsedLabel(elapsedSecondsSince(this.session().stateSince, this.now()));
    return elapsed === null ? NOT_KNOWN : `${elapsed} ago`;
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
    this.now.set(Date.now());
    const [profileResult, projectsResult] = await Promise.allSettled([this.fetchProfile(sessionId), this.fetchProjects()]);
    const isStillShown = this.sessionId() === sessionId;
    if (!isStillShown) return;
    if (projectsResult.status === 'fulfilled') this.projects.set(projectsResult.value.items);
    if (profileResult.status === 'rejected') {
      this.status.set('failed');
      return;
    }
    this.profile.set(profileResult.value);
    this.status.set('ready');
  }

  private async fetchProfile(sessionId: string): Promise<ManagerProfile> {
    return this.api.getManagerProfile(sessionId);
  }

  private async fetchProjects(): Promise<Page<Project>> {
    return this.api.listProjects();
  }

  protected async finishEditing(saved: ManagerView): Promise<void> {
    this.profile.update((current) => current && { ...current, manager: saved });
    this.isEditing.set(false);
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
