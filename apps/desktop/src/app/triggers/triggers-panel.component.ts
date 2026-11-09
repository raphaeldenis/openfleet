import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild, type Signal } from '@angular/core';
import type { TriggerFireView } from '@openfleet/shared';
import { copyFor, retryOfError } from '../core/error-copy';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { OperatorNonceMinter } from '../core/operator-nonce-minter';
import type { TriggerView } from '../core/playbook-trigger-views';
import { BannerComponent } from '../design/banner.component';
import { LOADING, failedLoadOf, loadedValueOf, type Load } from './load-state';
import { FIRE_REASON_LABELS, LEDGER_STATE_LABELS, conditionText, runText, whenText } from './rule-text';
import { BACKLOG_POLICIES, BATCH_MODES, changesOf, draftOf, problemOfDraft, type TriggerEditDraft } from './trigger-edit-draft';

type ArmingState = 'disarmed' | 'armed' | 'lapsed';

interface WriteFailure {
  message: string;
}

const ARMING_LABELS: Record<ArmingState, string> = { disarmed: 'Désarmé', armed: 'Armé', lapsed: 'Armement caduc' };

/** An armed trigger whose digest to review is no longer the approved one is armed on paper only: the engine does not fire it. */
function armingStateOf(trigger: TriggerView): ArmingState {
  const isArmed = trigger.armedAt !== null;
  if (!isArmed) return 'disarmed';
  const hasLapsed = trigger.reviewDigest !== undefined && trigger.reviewDigest !== trigger.approvedGraphDigest;
  return hasLapsed ? 'lapsed' : 'armed';
}

/** What the human reviewed is the revision and the digest on their screen; the trigger read again must still be that. */
const hasMovedSinceReview = ({ reviewed, current }: { reviewed: TriggerView; current: TriggerView }) =>
  current.contentRev !== reviewed.contentRev || current.reviewDigest !== reviewed.reviewDigest;

/** Spoken as the daemon would refuse a stale revision, so the copy and the advice to reload come from the error registry. */
const reviewedRuleHasMoved = () => new ApiError(409, 'the reviewed rule changed before arming', 'stale_revision');

const valueOf = (event: Event) => (event.target as HTMLInputElement).value;

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
            <h2 #triggerHeading tabindex="-1">{{ trigger.title || 'Sans titre' }}</h2>
            <p class="meta">
              <span class="pill" data-testid="trigger-arming-pill" [attr.data-state]="armingStateOf(trigger)">{{ armingLabelOf(trigger) }}</span>
              <span data-testid="trigger-arming">{{ armingText(trigger) }}</span>
            </p>
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

          @if (writeFailure(); as failure) {
            <p #writeAlert tabindex="-1" class="error" role="alert" data-testid="write-error">{{ failure.message }}</p>
          }

          @if (draft(); as editing) {
            <form class="editor" aria-label="Modifier le trigger" data-testid="trigger-editor" (submit)="submitEdit($event, trigger)">
              <p class="muted">Enregistrer désarme le trigger : il faudra relire la règle et l’armer de nouveau.</p>
              <label>Titre <input #titleField type="text" [value]="editing.title" (input)="editDraft({ title: valueOf($event) })" /></label>
              <label>Repos (secondes) <input type="text" inputmode="numeric" [value]="editing.cooldownSeconds" [attr.aria-describedby]="draftProblem() ? 'editor-problem' : null" (input)="editDraft({ cooldownSeconds: valueOf($event) })" /></label>
              <label>Plafond de tirs par jour <input type="text" inputmode="numeric" [value]="editing.maxFiresPerDay" [attr.aria-describedby]="draftProblem() ? 'editor-problem' : null" (input)="editDraft({ maxFiresPerDay: valueOf($event) })" /></label>
              <span class="muted">Un plafond vide laisse le trigger sans plafond journalier.</span>
              <label>Mode de lot
                <select (change)="editDraft({ batchMode: batchModeOf($event) })">
                  @for (mode of batchModes; track mode) { <option [value]="mode" [selected]="mode === editing.batchMode">{{ mode }}</option> }
                </select>
              </label>
              <label>Arriéré
                <select (change)="editDraft({ backlogPolicy: backlogPolicyOf($event) })">
                  @for (policy of backlogPolicies; track policy) { <option [value]="policy" [selected]="policy === editing.backlogPolicy">{{ policy }}</option> }
                </select>
              </label>
              @if (draftProblem(); as problem) { <p id="editor-problem" class="error" data-testid="editor-problem">{{ problem }}</p> }
              <div class="actions">
                <button type="submit" class="of-btn of-btn--compact" [disabled]="draftProblem() !== undefined || isWriting()">Enregistrer</button>
                <button type="button" class="of-btn of-btn--compact" (click)="cancelEdit()">Annuler</button>
              </div>
            </form>
          } @else {
            <h3>Revue avant armement</h3>
            <p data-testid="review-digest">Empreinte à approuver, en lecture seule : <code>{{ trigger.reviewDigest ?? 'indisponible' }}</code></p>
            <div class="actions">
              @if (armingStateOf(trigger) !== 'armed') {
                <button type="button" class="of-btn of-btn--compact" [attr.aria-label]="'Armer la révision ' + trigger.contentRev" [disabled]="isWriting()" (click)="arm(trigger)">Armer</button>
              }
              @if (trigger.armedAt !== null) {
                <button type="button" class="of-btn of-btn--compact" [disabled]="isWriting()" (click)="disarm(trigger)">Désarmer</button>
              }
              <button type="button" class="of-btn of-btn--compact" [disabled]="isWriting()" (click)="startEditing(trigger)">Modifier</button>
            </div>
          }

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
    .pill { display: inline-block; margin-right: .5rem; padding: 0 .5rem; border-radius: 999px; background: var(--sunk); color: var(--fg); font-weight: 500; }
    .pill[data-state='lapsed'] { color: var(--state-error); }
    .error { color: var(--state-error); margin: 0; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .editor { display: flex; flex-direction: column; align-items: flex-start; gap: .5rem; }
    .editor label { display: flex; flex-direction: column; gap: .125rem; }
    .skeleton { height: 8rem; margin: .5rem; border-radius: .625rem; background: var(--sunk); }
    .empty { display: flex; flex-direction: column; gap: .25rem; padding: 2rem 1rem; text-align: center; color: var(--mut); }
    .empty-title { color: var(--fg); font-weight: 500; }
  `,
})
export class TriggersPanelComponent {
  readonly projectId = input.required<string>();

  private readonly api = inject(FleetApiService);
  private readonly nonceMinter = inject(OperatorNonceMinter);
  private readonly injector = inject(Injector);
  private readonly triggerHeading = viewChild<ElementRef<HTMLElement>>('triggerHeading');
  private readonly writeAlert = viewChild<ElementRef<HTMLElement>>('writeAlert');
  private readonly titleField = viewChild<ElementRef<HTMLElement>>('titleField');
  protected readonly triggers = signal<Load<TriggerView[]>>(LOADING);
  protected readonly selectedId = signal<string | undefined>(undefined);
  protected readonly fires = signal<Load<TriggerFireView[]>>(LOADING);
  protected readonly draft = signal<TriggerEditDraft | undefined>(undefined);
  protected readonly writeFailure = signal<WriteFailure | undefined>(undefined);
  private readonly triggerIdsBeingWritten = signal<readonly string[]>([]);

  protected readonly batchModes = BATCH_MODES;
  protected readonly backlogPolicies = BACKLOG_POLICIES;
  protected readonly valueOf = valueOf;
  protected readonly armingStateOf = armingStateOf;

  protected readonly loadedTriggers = computed(() => loadedValueOf(this.triggers()));
  protected readonly loadedFires = computed(() => loadedValueOf(this.fires()));
  protected readonly selected = computed(() => this.loadedTriggers()?.find((trigger) => trigger.id === this.selectedId()));
  protected readonly failureMessage = computed(() => { const load = this.triggers(); return load.status === 'failed' ? load.message : ''; });
  protected readonly firesFailureMessage = computed(() => { const load = this.fires(); return load.status === 'failed' ? load.message : ''; });

  protected readonly isWriting = computed(() => this.triggerIdsBeingWritten().includes(this.selectedId() ?? ''));
  protected readonly draftProblem = computed(() => { const draft = this.draft(); return draft === undefined ? undefined : problemOfDraft(draft); });

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
        this.forgetWriteState();
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
    this.forgetWriteState();
    this.fires.set(LOADING);
    try {
      const fires = await this.api.listTriggerFires(triggerId);
      if (request === this.latestFiresRequest) this.fires.set({ status: 'loaded', value: fires });
    } catch (error) {
      if (request === this.latestFiresRequest) this.fires.set(failedLoadOf(error));
    }
  }

  /** The refusal and the open form belong to the trigger chosen when they appeared. */
  private forgetWriteState(): void {
    this.writeFailure.set(undefined);
    this.draft.set(undefined);
  }

  protected arm(reviewed: TriggerView): Promise<void> {
    return this.performWrite(reviewed.id, async () => {
      const current = await this.api.getTrigger(reviewed.id);
      if (hasMovedSinceReview({ reviewed, current })) throw reviewedRuleHasMoved();
      const humanProof = await this.nonceMinter.mintTriggerArmingNonce(reviewed.id);
      await this.api.armTrigger({ triggerId: reviewed.id, approvedRev: reviewed.contentRev, humanProof });
    });
  }

  protected disarm(trigger: TriggerView): Promise<void> {
    return this.performWrite(trigger.id, async () => { await this.api.disarmTrigger(trigger.id); });
  }

  protected startEditing(trigger: TriggerView): void {
    this.writeFailure.set(undefined);
    this.draft.set(draftOf(trigger));
    this.focusAfterRender(this.titleField);
  }

  protected cancelEdit(): void {
    this.draft.set(undefined);
    this.focusAfterRender(this.triggerHeading);
  }

  protected editDraft(change: Partial<TriggerEditDraft>): void {
    this.draft.update((draft) => (draft === undefined ? draft : { ...draft, ...change }));
  }

  protected batchModeOf(event: Event) { return valueOf(event) as TriggerEditDraft['batchMode']; }
  protected backlogPolicyOf(event: Event) { return valueOf(event) as TriggerEditDraft['backlogPolicy']; }

  protected submitEdit(event: Event, trigger: TriggerView): Promise<void> {
    event.preventDefault();
    const draft = this.draft();
    const hasNothingToSave = draft === undefined || problemOfDraft(draft) !== undefined;
    if (hasNothingToSave) return Promise.resolve();
    return this.performWrite(trigger.id, async () => {
      await this.api.updateTrigger({ triggerId: trigger.id, expectedRev: trigger.contentRev, changes: changesOf(draft, trigger) });
    });
  }

  /**
   * Runs one write on a trigger, then reads the list again so the screen shows what the daemon holds.
   * Only the trigger still chosen when the answer comes back gets the focus, the refusal or the closed form.
   */
  private async performWrite(triggerId: string, write: () => Promise<void>): Promise<void> {
    if (this.triggerIdsBeingWritten().includes(triggerId)) return;
    const selectionAtStart = this.latestFiresRequest;
    const isStillOnSelectionAtStart = () => selectionAtStart === this.latestFiresRequest;
    this.triggerIdsBeingWritten.update((ids) => [...ids, triggerId]);
    this.writeFailure.set(undefined);
    try {
      await write();
      await this.refreshTriggers();
      if (!isStillOnSelectionAtStart()) return;
      this.draft.set(undefined);
      this.focusAfterRender(this.triggerHeading);
    } catch (error) {
      const isReloadAdvised = retryOfError(error) === 'after_refresh';
      if (isReloadAdvised) await this.refreshTriggers();
      if (!isStillOnSelectionAtStart()) return;
      if (isReloadAdvised) this.draft.set(undefined);
      this.writeFailure.set({ message: copyFor(error, { action: 'generic' }).text });
      this.focusAfterRender(this.writeAlert);
    } finally {
      this.triggerIdsBeingWritten.update((ids) => ids.filter((id) => id !== triggerId));
    }
  }

  /** Replaces the list without the loading state, so the trigger on screen stays; a project chosen since owns its own list. */
  private async refreshTriggers(): Promise<void> {
    const request = ++this.latestListRequest;
    const items = await this.api.listTriggers(this.projectId()).catch(() => undefined);
    if (items !== undefined && request === this.latestListRequest) this.triggers.set({ status: 'loaded', value: items });
  }

  private focusAfterRender(target: Signal<ElementRef<HTMLElement> | undefined>): void {
    afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }

  protected armingLabelOf(trigger: TriggerView): string { return ARMING_LABELS[armingStateOf(trigger)]; }

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
