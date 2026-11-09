import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild, type Signal } from '@angular/core';
import { FleetApiService } from '../core/fleet-api.service';
import { copyFor, retryOfError } from '../core/error-copy';
import type { PlaybookSecretStatus, PlaybookVersionContent, PlaybookVersionList, PlaybookView } from '../core/playbook-trigger-views';
import { BannerComponent } from '../design/banner.component';
import { LOADING, failedLoadOf, loadedValueOf, type Load } from './load-state';

interface PlaybookDetail {
  versions: PlaybookVersionList;
  secrets: PlaybookSecretStatus[];
}

interface RestoreFailure {
  message: string;
  isReloadAdvised: boolean;
}

const ORIGIN_LABELS = { native: 'Créé ici', imported: 'Importé', agent: 'Écrit par un agent' } as const;
const SOURCE_LABELS = { edit: 'Modification', restore: 'Restauration' } as const;

/**
 * The playbooks of a project: the list, then for the chosen one its cells, the status of its secrets and its versions.
 * Restoring a version is the only write of this screen; it always sends `expectedRev`, the current revision the screen read.
 */
@Component({
  selector: 'of-playbooks-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent],
  template: `
    <div class="split">
      <nav class="list" aria-label="Playbooks">
        @switch (playbooks().status) {
          @case ('loading') { <div class="skeleton" data-testid="playbooks-loading" role="status" aria-label="Chargement des playbooks"></div> }
          @case ('failed') {
            <of-banner data-testid="playbooks-error" variant="error" glyph="✕" title="Playbooks indisponibles" [description]="failureMessage()">
              <button type="button" class="of-btn of-btn--compact" (click)="reload()">Réessayer</button>
            </of-banner>
          }
        }
        @if (loadedPlaybooks(); as items) {
          @if (items.length === 0) {
            <p class="empty" data-testid="playbooks-empty"><span class="empty-title">Aucun playbook</span>Ce projet n’en a pas encore.</p>
          } @else {
            <ul>
              @for (playbook of items; track playbook.id) {
                <li>
                  <button type="button" class="row of-focus-ring" [attr.aria-current]="playbook.id === selectedId() ? 'true' : null" (click)="select(playbook.id)">
                    <span class="row-title">{{ playbook.name }}</span>
                    <span class="row-meta">{{ playbook.flow.cells.length }} cellules · rév. {{ playbook.contentRev }}</span>
                  </button>
                </li>
              }
            </ul>
          }
        }
      </nav>

      <section class="detail" aria-live="polite" data-testid="playbook-detail">
        @if (selected(); as playbook) {
          <header>
            <h2 #playbookHeading tabindex="-1">{{ playbook.name }}</h2>
            <p class="meta">
              {{ originLabel(playbook) }} · révision {{ playbook.contentRev }}
              @if (playbook.agentLocked) { · verrouillé aux agents }
              · {{ playbook.approvedDigest === null ? 'jamais approuvé' : 'approuvé' }}
            </p>
          </header>

          <h3>Cellules</h3>
          @if (playbook.flow.cells.length === 0) {
            <p class="muted" data-testid="playbook-no-cells">Ce playbook n’a aucune cellule.</p>
          } @else {
            <ol class="cells" aria-label="Cellules du playbook">
              @for (cell of playbook.flow.cells; track cell.id) {
                <li><code>{{ cell.kind }}</code> {{ cell.label ?? cell.id }}</li>
              }
            </ol>
          }

          @switch (detail().status) {
            @case ('loading') { <div class="skeleton" data-testid="playbook-detail-loading" role="status" aria-label="Chargement du détail"></div> }
            @case ('failed') {
              <of-banner data-testid="playbook-detail-error" variant="error" glyph="✕" title="Détail indisponible" [description]="detailFailureMessage()">
                <button type="button" class="of-btn of-btn--compact" (click)="select(playbook.id)">Réessayer</button>
              </of-banner>
            }
          }

          @if (loadedDetail(); as loaded) {
            <h3>Secrets déclarés</h3>
            @if (loaded.secrets.length === 0) {
              <p class="muted" data-testid="playbook-no-secrets">Aucun secret déclaré.</p>
            } @else {
              <ul class="secrets" aria-label="Secrets du playbook">
                @for (secret of loaded.secrets; track secret.name) {
                  <li [attr.data-testid]="'secret-' + secret.name">
                    <code>{{ secret.name }}</code>
                    <span class="status" [attr.data-status]="secret.status">{{ secret.status === 'stored' ? 'Renseigné sur cet appareil' : 'Manquant' }}</span>
                    @if (secret.status === 'missing') { <span class="muted">à saisir dans l’app, pas encore possible ici</span> }
                  </li>
                }
              </ul>
            }

            <h3>Versions</h3>
            @if (restoreFailure(); as failure) {
              <div class="restore-failure">
                <p #restoreAlert tabindex="-1" class="error" role="alert" data-testid="restore-error">{{ failure.message }}</p>
                @if (failure.isReloadAdvised) { <button type="button" class="of-btn of-btn--compact" (click)="reloadPlaybook(playbook.id)">Recharger</button> }
              </div>
            }
            <ul class="versions" aria-label="Versions du playbook">
              @for (version of loaded.versions.versions; track version.rev) {
                <li>
                  <span>Rév. {{ version.rev }} · {{ sourceLabel(version.source) }} · {{ version.cellCount }} cellules</span>
                  <button type="button" class="of-btn of-btn--compact" [attr.aria-label]="'Lire la révision ' + version.rev" (click)="readVersion(playbook.id, version.rev)">Lire</button>
                  @if (version.rev === loaded.versions.currentContentRev) {
                    <span class="muted">révision actuelle</span>
                  } @else {
                    <button type="button" class="of-btn of-btn--compact" [attr.aria-label]="'Restaurer la révision ' + version.rev" [disabled]="isRestoring()" (click)="restore(playbook.id, version.rev)">Restaurer</button>
                  }
                </li>
              }
            </ul>
            @switch (openedVersion().status) {
              @case ('loading') { <p class="muted" role="status">Lecture de la révision…</p> }
              @case ('failed') { <p class="error" role="alert" data-testid="version-error">{{ openedVersionFailure() }}</p> }
            }
            @if (loadedOpenedVersion(); as opened) {
              <section class="opened" [attr.aria-label]="'Révision ' + opened.rev" data-testid="opened-version">
                <h4>Révision {{ opened.rev }} : {{ opened.name }}</h4>
                <ol class="cells">
                  @for (cell of opened.flow.cells; track cell.id) { <li><code>{{ cell.kind }}</code> {{ cell.label ?? cell.id }}</li> }
                </ol>
              </section>
            }
          }
        } @else {
          <p class="muted" data-testid="playbook-none-selected">Choisissez un playbook pour lire ses cellules, ses secrets et ses versions.</p>
        }
      </section>
    </div>
  `,
  styles: `
    :host { display: flex; flex: 1 1 0%; min-height: 0; min-width: 0; }
    .split { flex: 1; display: flex; min-height: 0; }
    .list { width: 18rem; flex: none; overflow: auto; border-right: 1px solid var(--line); padding: .5rem; }
    ul { list-style: none; margin: 0; padding: 0; }
    .row { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: .125rem; padding: .5rem .625rem; border: 0; border-radius: .5rem; background: transparent; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
    .row[aria-current='true'] { background: var(--sunk); }
    .row-title { font-weight: 500; }
    .row-meta, .muted, .meta { color: var(--mut); font-size: .8125rem; }
    .detail { flex: 1; min-width: 0; overflow: auto; padding: 1rem; display: flex; flex-direction: column; gap: .5rem; }
    h2 { margin: 0; font-size: 1rem; } h3 { margin: .75rem 0 0; font-size: .875rem; } h4 { margin: 0 0 .25rem; font-size: .8125rem; }
    .cells { margin: 0; padding-left: 1.25rem; }
    .secrets li, .versions li { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: .25rem 0; }
    .status[data-status='missing'] { color: var(--state-error); }
    .error { color: var(--state-error); margin: 0; }
    .restore-failure { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    .skeleton { height: 8rem; margin: .5rem; border-radius: .625rem; background: var(--sunk); }
    .empty { display: flex; flex-direction: column; gap: .25rem; padding: 2rem 1rem; text-align: center; color: var(--mut); }
    .empty-title { color: var(--fg); font-weight: 500; }
  `,
})
export class PlaybooksPanelComponent {
  readonly projectId = input.required<string>();

  private readonly api = inject(FleetApiService);
  private readonly injector = inject(Injector);
  private readonly playbookHeading = viewChild<ElementRef<HTMLElement>>('playbookHeading');
  private readonly restoreAlert = viewChild<ElementRef<HTMLElement>>('restoreAlert');
  protected readonly playbooks = signal<Load<PlaybookView[]>>(LOADING);
  protected readonly selectedId = signal<string | undefined>(undefined);
  protected readonly detail = signal<Load<PlaybookDetail>>(LOADING);
  protected readonly openedVersion = signal<Load<PlaybookVersionContent> | { status: 'closed' }>({ status: 'closed' });
  protected readonly restoreFailure = signal<RestoreFailure | undefined>(undefined);
  protected readonly isRestoring = signal(false);

  protected readonly loadedPlaybooks = computed(() => loadedValueOf(this.playbooks()));
  protected readonly loadedDetail = computed(() => loadedValueOf(this.detail()));
  protected readonly selected = computed(() => this.loadedPlaybooks()?.find((playbook) => playbook.id === this.selectedId()));
  protected readonly failureMessage = computed(() => { const load = this.playbooks(); return load.status === 'failed' ? load.message : ''; });
  protected readonly detailFailureMessage = computed(() => { const load = this.detail(); return load.status === 'failed' ? load.message : ''; });
  protected readonly loadedOpenedVersion = computed(() => { const opened = this.openedVersion(); return opened.status === 'loaded' ? opened.value : undefined; });
  protected readonly openedVersionFailure = computed(() => { const opened = this.openedVersion(); return opened.status === 'failed' ? opened.message : ''; });

  private latestListRequest = 0;
  private latestSelectionRequest = 0;
  private latestVersionRequest = 0;

  constructor() {
    effect(() => {
      this.projectId();
      untracked(() => {
        this.forgetSelection();
        void this.reload();
      });
    });
  }

  private forgetSelection(): void {
    this.invalidateRequestsOfPreviousSelection();
    this.selectedId.set(undefined);
    this.openedVersion.set({ status: 'closed' });
    this.restoreFailure.set(undefined);
  }

  /** Detail, version reads and restoration continuations started under an earlier selection find their token outdated. */
  private invalidateRequestsOfPreviousSelection(): number {
    this.latestVersionRequest += 1;
    return ++this.latestSelectionRequest;
  }

  protected async reload(): Promise<void> {
    const request = ++this.latestListRequest;
    this.playbooks.set(LOADING);
    try {
      const items = await this.api.listPlaybooks(this.projectId());
      if (request !== this.latestListRequest) return;
      this.playbooks.set({ status: 'loaded', value: items });
    } catch (error) {
      if (request === this.latestListRequest) this.playbooks.set(failedLoadOf(error));
    }
  }

  protected originLabel(playbook: PlaybookView): string { return ORIGIN_LABELS[playbook.origin]; }
  protected sourceLabel(source: keyof typeof SOURCE_LABELS): string { return SOURCE_LABELS[source]; }

  protected async select(playbookId: string): Promise<void> {
    const request = this.invalidateRequestsOfPreviousSelection();
    this.selectedId.set(playbookId);
    this.detail.set(LOADING);
    this.openedVersion.set({ status: 'closed' });
    this.restoreFailure.set(undefined);
    const playbook = this.loadedPlaybooks()?.find((candidate) => candidate.id === playbookId);
    try {
      const [versions, secrets] = await Promise.all([this.api.listPlaybookVersions(playbookId), this.secretStatusesOf(playbookId, playbook?.secrets ?? [])]);
      if (request !== this.latestSelectionRequest) return;
      this.detail.set({ status: 'loaded', value: { versions, secrets } });
    } catch (error) {
      if (request === this.latestSelectionRequest) this.detail.set(failedLoadOf(error));
    }
  }

  private async secretStatusesOf(playbookId: string, names: readonly string[]): Promise<PlaybookSecretStatus[]> {
    return Promise.all(names.map(async (name) => {
      const answer = await this.api.getPlaybookSecretStatus(playbookId, name);
      return { name, status: answer.status };
    }));
  }

  protected async readVersion(playbookId: string, rev: number): Promise<void> {
    const request = ++this.latestVersionRequest;
    this.openedVersion.set(LOADING);
    try {
      const version = await this.api.getPlaybookVersion(playbookId, rev);
      if (request === this.latestVersionRequest) this.openedVersion.set({ status: 'loaded', value: version });
    } catch (error) {
      if (request === this.latestVersionRequest) this.openedVersion.set(failedLoadOf(error));
    }
  }

  protected async restore(playbookId: string, rev: number): Promise<void> {
    const versions = this.loadedDetail()?.versions;
    if (versions === undefined || this.isRestoring()) return;
    const selectionAtStart = this.latestSelectionRequest;
    const listRequestAtStart = this.latestListRequest;
    const isStillOnSelectionAtStart = () => selectionAtStart === this.latestSelectionRequest;
    this.isRestoring.set(true);
    this.restoreFailure.set(undefined);
    try {
      await this.api.restorePlaybookVersion({ playbookId, rev, expectedRev: versions.currentContentRev });
      if (!isStillOnSelectionAtStart()) {
        void this.refreshListWithoutLeavingSelection(listRequestAtStart);
        return;
      }
      await this.showFreshPlaybook(playbookId);
    } catch (error) {
      if (!isStillOnSelectionAtStart()) return;
      this.restoreFailure.set({ message: copyFor(error, { action: 'generic' }).text, isReloadAdvised: retryOfError(error) === 'after_refresh' });
      this.focusAfterRender(this.restoreAlert);
    } finally {
      this.isRestoring.set(false);
    }
  }

  protected async reloadPlaybook(playbookId: string): Promise<void> {
    await this.showFreshPlaybook(playbookId);
  }

  /** Reads the list and the detail again, then puts the keyboard focus on the heading of the playbook; does nothing once the user has moved to another project. */
  private async showFreshPlaybook(playbookId: string): Promise<void> {
    const selectionAtStart = this.latestSelectionRequest;
    await this.reload();
    const hasMovedOn = selectionAtStart !== this.latestSelectionRequest;
    if (hasMovedOn) return;
    await this.select(playbookId);
    if (this.selectedId() === playbookId) this.focusAfterRender(this.playbookHeading);
  }

  /** Replaces the cached list without the loading state, so the playbook chosen meanwhile stays on screen; a project chosen since owns its own list. */
  private async refreshListWithoutLeavingSelection(listRequestAtStart: number): Promise<void> {
    const isListOfSameProject = () => listRequestAtStart === this.latestListRequest;
    if (!isListOfSameProject()) return;
    const items = await this.api.listPlaybooks(this.projectId()).catch(() => undefined);
    if (items !== undefined && isListOfSameProject()) this.playbooks.set({ status: 'loaded', value: items });
  }

  private focusAfterRender(target: Signal<ElementRef<HTMLElement> | undefined>): void {
    afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }
}
