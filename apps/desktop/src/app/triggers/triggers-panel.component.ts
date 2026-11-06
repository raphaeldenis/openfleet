import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { TriggerFireView } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import type { TriggerView } from '../core/playbook-trigger-views';
import { BannerComponent } from '../design/banner.component';
import { LOADING, failedLoadOf, loadedValueOf, type Load } from './load-state';
import { FIRE_REASON_LABELS, LEDGER_STATE_LABELS, conditionText, runText, whenText } from './rule-text';

/** The triggers of a project: the list, then for the chosen one its rule as stored, its arming and the history of its fires. */
@Component({
  selector: 'of-triggers-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent],
  template: `
    <div class="split">
      <nav class="list" aria-label="Triggers">
        @switch (triggers().status) {
          @case ('loading') { <div class="skeleton" data-testid="triggers-loading" role="status" aria-label="Chargement des triggers"></div> }
          @case ('failed') {
            <of-banner data-testid="triggers-error" variant="error" glyph="✕" title="Triggers indisponibles" [description]="failureMessage()">
              <button type="button" class="of-btn of-btn--compact" (click)="reload()">Réessayer</button>
            </of-banner>
          }
        }
        @if (loadedTriggers(); as items) {
          @if (items.length === 0) {
            <p class="empty" data-testid="triggers-empty"><span class="empty-title">Aucun trigger</span>Ce projet n’en a pas encore.</p>
          } @else {
            <ul>
              @for (trigger of items; track trigger.id) {
                <li>
                  <button type="button" class="row of-focus-ring" [attr.aria-current]="trigger.id === selectedId() ? 'true' : null" (click)="select(trigger.id)">
                    <span class="row-title">{{ trigger.title || 'Sans titre' }}</span>
                    <span class="row-meta">{{ trigger.armedAt === null ? 'Désarmé' : 'Armé' }} · rév. {{ trigger.contentRev }}</span>
                  </button>
                </li>
              }
            </ul>
          }
        }
      </nav>

      <section class="detail" aria-live="polite" data-testid="trigger-detail">
        @if (selected(); as trigger) {
          <header>
            <h2>{{ trigger.title || 'Sans titre' }}</h2>
            <p class="meta" data-testid="trigger-arming">{{ armingText(trigger) }}</p>
          </header>

          <h3>Règle</h3>
          <dl class="rule">
            <dt>Quand</dt><dd>{{ whenText(trigger.when) }}</dd>
            <dt>Conditions</dt>
            <dd>
              @if (trigger.conditions.length === 0) { Aucune } @else {
                <ol class="conditions">
                  @for (condition of trigger.conditions; track condition.id; let first = $first) { <li>{{ conditionText(condition, { isFirst: first }) }}</li> }
                </ol>
              }
            </dd>
            <dt>Alors</dt><dd>{{ runText(trigger.run) }}</dd>
            <dt>Propriétaire</dt><dd>{{ trigger.ownerManagerId ?? 'Aucun manager' }}</dd>
            <dt>Politique</dt><dd>{{ policyText(trigger) }}</dd>
          </dl>

          <h3>Historique des tirs</h3>
          @switch (fires().status) {
            @case ('loading') { <div class="skeleton" data-testid="fires-loading" role="status" aria-label="Chargement des tirs"></div> }
            @case ('failed') {
              <of-banner data-testid="fires-error" variant="error" glyph="✕" title="Historique indisponible" [description]="firesFailureMessage()">
                <button type="button" class="of-btn of-btn--compact" (click)="select(trigger.id)">Réessayer</button>
              </of-banner>
            }
          }
          @if (loadedFires(); as firesOfTrigger) {
            @if (firesOfTrigger.length === 0) {
              <p class="muted" data-testid="fires-empty">Ce trigger n’a pas encore tiré.</p>
            } @else {
              <ul class="fires" aria-label="Tirs du trigger">
                @for (fire of firesOfTrigger; track fire.id) {
                  <li [attr.data-testid]="'fire-' + fire.id">
                    <span class="state" [attr.data-state]="fire.ledgerState">{{ ledgerLabel(fire) }}</span>
                    <time [attr.datetime]="fire.firedAt">{{ fire.firedAt }}</time>
                    @if (fire.reason !== null) { <span class="muted">{{ reasonLabel(fire) }}</span> }
                  </li>
                }
              </ul>
            }
          }
        } @else {
          <p class="muted" data-testid="trigger-none-selected">Choisissez un trigger pour lire sa règle et l’historique de ses tirs.</p>
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
    h2 { margin: 0; font-size: 1rem; } h3 { margin: .75rem 0 0; font-size: .875rem; }
    .rule { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; }
    .rule dt { color: var(--mut); } .rule dd { margin: 0; }
    .conditions { margin: 0; padding-left: 1.25rem; }
    .fires li { display: flex; flex-wrap: wrap; gap: .5rem; padding: .25rem 0; }
    .state[data-state='needs_review'] { color: var(--state-error); }
    .skeleton { height: 8rem; margin: .5rem; border-radius: .625rem; background: var(--sunk); }
    .empty { display: flex; flex-direction: column; gap: .25rem; padding: 2rem 1rem; text-align: center; color: var(--mut); }
    .empty-title { color: var(--fg); font-weight: 500; }
  `,
})
export class TriggersPanelComponent {
  readonly projectId = input.required<string>();

  private readonly api = inject(FleetApiService);
  protected readonly triggers = signal<Load<TriggerView[]>>(LOADING);
  protected readonly selectedId = signal<string | undefined>(undefined);
  protected readonly fires = signal<Load<TriggerFireView[]>>(LOADING);

  protected readonly loadedTriggers = computed(() => loadedValueOf(this.triggers()));
  protected readonly loadedFires = computed(() => loadedValueOf(this.fires()));
  protected readonly selected = computed(() => this.loadedTriggers()?.find((trigger) => trigger.id === this.selectedId()));
  protected readonly failureMessage = computed(() => { const load = this.triggers(); return load.status === 'failed' ? load.message : ''; });
  protected readonly firesFailureMessage = computed(() => { const load = this.fires(); return load.status === 'failed' ? load.message : ''; });

  protected readonly whenText = whenText;
  protected readonly runText = runText;
  protected readonly conditionText = conditionText;

  private latestListRequest = 0;
  private latestFiresRequest = 0;

  constructor() {
    effect(() => {
      this.projectId();
      untracked(() => {
        this.latestFiresRequest += 1;
        this.selectedId.set(undefined);
        void this.reload();
      });
    });
  }

  protected async reload(): Promise<void> {
    const request = ++this.latestListRequest;
    this.triggers.set(LOADING);
    try {
      const items = await this.api.listTriggers(this.projectId());
      if (request === this.latestListRequest) this.triggers.set({ status: 'loaded', value: items });
    } catch (error) {
      if (request === this.latestListRequest) this.triggers.set(failedLoadOf(error));
    }
  }

  protected async select(triggerId: string): Promise<void> {
    const request = ++this.latestFiresRequest;
    this.selectedId.set(triggerId);
    this.fires.set(LOADING);
    try {
      const fires = await this.api.listTriggerFires(triggerId);
      if (request === this.latestFiresRequest) this.fires.set({ status: 'loaded', value: fires });
    } catch (error) {
      if (request === this.latestFiresRequest) this.fires.set(failedLoadOf(error));
    }
  }

  protected ledgerLabel(fire: TriggerFireView): string { return LEDGER_STATE_LABELS[fire.ledgerState]; }
  protected reasonLabel(fire: TriggerFireView): string { return fire.reason === null ? '' : FIRE_REASON_LABELS[fire.reason]; }

  protected armingText(trigger: TriggerView): string {
    const isArmed = trigger.armedAt !== null;
    if (!isArmed) return `Désarmé · révision ${trigger.contentRev}`;
    return `Armé le ${trigger.armedAt} sur la révision ${trigger.approvedRev} · digest approuvé ${trigger.approvedGraphDigest}`;
  }

  protected policyText(trigger: TriggerView): string {
    const { cooldownSeconds, maxFiresPerDay, batchMode, backlogPolicy } = trigger.policy;
    const dailyCap = maxFiresPerDay === undefined ? 'sans plafond journalier' : `${maxFiresPerDay} tirs par jour au plus`;
    return `repos ${cooldownSeconds} s · ${dailyCap} · ${batchMode} · arriéré ${backlogPolicy}`;
  }
}
