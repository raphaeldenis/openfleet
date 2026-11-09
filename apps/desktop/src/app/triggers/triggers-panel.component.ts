import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild, type Signal } from '@angular/core';
import type { TriggerFireView } from '@openfleet/shared';
import { acceptedOwnerOf, ownerChoicesOf, type OwnerChoice } from './owner-choices';
import { TriggerEditorComponent } from './trigger-editor.component';
import type { WhenDraft } from './when-draft';
import { copyFor, retryOfError } from '../core/error-copy';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { OperatorNonceMinter } from '../core/operator-nonce-minter';
import type { TriggerView } from '../core/playbook-trigger-views';
import { BannerComponent } from '../design/banner.component';
import { approvalReviewOf, previewOf } from './approval-review';
import { LOADING, failedLoadOf, loadedValueOf, type Load } from './load-state';
import { FIRE_REASON_LABELS, LEDGER_STATE_LABELS, conditionText, runText, whenText } from './rule-text';
import { changesOf, draftOf, problemOfDraft, type TriggerEditDraft } from './trigger-edit-draft';

type ArmingState = 'disarmed' | 'armed' | 'lapsed';
type PillState = ArmingState | 'unknown';

interface WriteFailure {
  message: string;
}

/** A write the daemon accepted whose effect on the trigger could not be read back: nothing on screen says what the daemon holds. */
interface UnconfirmedState {
  triggerId: string;
  mayBeArmed: boolean;
}

interface WriteTarget {
  triggerId: string;
  mayBeArmedAfterwards: boolean;
}

type ListRefresh = { confirmed: true } | { confirmed: false; error: unknown };

const PILL_LABELS: Record<PillState, string> = { disarmed: 'Désarmé', armed: 'Armé', lapsed: 'Armement caduc', unknown: 'État inconnu — recharger' };

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

/** The triggers of a project: the list, then for the chosen one its rule as stored, its arming and the history of its fires. */
@Component({
  selector: 'of-triggers-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent, TriggerEditorComponent],
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
                    <span class="row-meta">{{ rowStateLabelOf(trigger) }} · rév. {{ trigger.contentRev }}</span>
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
              <span class="pill" data-testid="trigger-arming-pill" [attr.data-state]="pillStateOf(trigger)">{{ pillLabelOf(trigger) }}</span>
              <span data-testid="trigger-arming">{{ armingText(trigger) }}</span>
            </p>
          </header>

          @if (unconfirmedState(); as unconfirmed) {
            <p data-testid="state-unknown">Le démon a accepté l’écriture, mais la relecture a échoué : l’état de ce trigger n’est pas connu. Rechargez avant d’agir.</p>
            <div class="actions">
              <button type="button" class="of-btn of-btn--compact" (click)="recheck()">Recharger</button>
              @if (unconfirmed.mayBeArmed) {
                <button type="button" class="of-btn of-btn--compact" [disabled]="isWriting()" (click)="disarm(trigger)">Désarmer</button>
              }
            </div>
          } @else {
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
          }

          @if (writeFailure(); as failure) {
            <p #writeAlert tabindex="-1" class="error" role="alert" data-testid="write-error">{{ failure.message }}</p>
          }

          @if (draft(); as editing) {
            <of-trigger-editor
              [draft]="editing" [problem]="draftProblem()" [managers]="managers()" [isWriting]="isWriting()"
              (draftChange)="editDraft($event)" (whenChange)="editWhen($event)" (ownerChosen)="chooseOwner($event)" (managersRetried)="loadManagers()"
              (submitted)="submitEdit($event, trigger)" (cancelled)="cancelEdit()"
            />
          } @else if (unconfirmedState() === undefined) {
            @if (isSavedNoticeShown()) {
              <p class="notice" data-testid="edit-saved-notice">Modification enregistrée : le trigger est désarmé, à relire avant de l’armer de nouveau.</p>
            }
            <h3>Revue avant armement</h3>
            <p class="muted">Tout ce que couvre l’empreinte, en texte brut : ce qui est écrit dans le trigger n’est jamais interprété.</p>
            <dl class="review" data-testid="review-fields">
              @for (row of reviewRows(); track row.key) {
                <dt>{{ row.label }}</dt>
                <dd>
                  <span class="review-text">{{ row.shownText }}</span>
                  @if (row.hiddenChars > 0) {
                    <span class="muted"> … {{ row.hiddenChars }} caractères masqués</span>
                    <button type="button" class="of-btn of-btn--compact" [attr.aria-label]="'Tout lire : ' + row.label" (click)="readAll(row.key)">Tout lire</button>
                  }
                </dd>
              }
            </dl>
            <p data-testid="review-digest">Empreinte à approuver, en lecture seule : <code>{{ trigger.reviewDigest ?? 'indisponible' }}</code></p>
            @if (armBlockedReason(); as reason) { <p class="error" data-testid="arm-blocked">{{ reason }}</p> }
            <div class="actions">
              @if (armingStateOf(trigger) !== 'armed') {
                <button type="button" class="of-btn of-btn--compact" [attr.aria-label]="'Armer la révision ' + trigger.contentRev" [disabled]="isWriting() || armBlockedReason() !== undefined" (click)="arm(trigger)">Armer</button>
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
    .review { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; }
    .review dt { color: var(--mut); } .review dd { margin: 0; min-width: 0; }
    .review-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .conditions { margin: 0; padding-left: 1.25rem; }
    .fires li { display: flex; flex-wrap: wrap; gap: .5rem; padding: .25rem 0; }
    .state[data-state='needs_review'] { color: var(--state-error); }
    .pill { display: inline-block; margin-right: .5rem; padding: 0 .5rem; border-radius: 999px; background: var(--sunk); color: var(--fg); font-weight: 500; }
    .pill[data-state='lapsed'] { color: var(--state-error); }
    .error { color: var(--state-error); margin: 0; }
    .notice { margin: 0; color: var(--state-error); font-weight: 500; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
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
  protected readonly triggers = signal<Load<TriggerView[]>>(LOADING);
  protected readonly selectedId = signal<string | undefined>(undefined);
  protected readonly fires = signal<Load<TriggerFireView[]>>(LOADING);
  protected readonly draft = signal<TriggerEditDraft | undefined>(undefined);
  protected readonly managers = signal<Load<OwnerChoice[]>>(LOADING);
  private readonly savedTriggerId = signal<string | undefined>(undefined);
  protected readonly writeFailure = signal<WriteFailure | undefined>(undefined);
  private readonly triggerIdsBeingWritten = signal<readonly string[]>([]);
  private readonly unconfirmedStates = signal<readonly UnconfirmedState[]>([]);
  private readonly readInFullFieldIds = signal<ReadonlySet<string>>(new Set());

  protected readonly armingStateOf = armingStateOf;

  protected readonly loadedTriggers = computed(() => loadedValueOf(this.triggers()));
  protected readonly loadedFires = computed(() => loadedValueOf(this.fires()));
  protected readonly selected = computed(() => this.loadedTriggers()?.find((trigger) => trigger.id === this.selectedId()));
  protected readonly failureMessage = computed(() => { const load = this.triggers(); return load.status === 'failed' ? load.message : ''; });
  protected readonly firesFailureMessage = computed(() => { const load = this.fires(); return load.status === 'failed' ? load.message : ''; });

  protected readonly isWriting = computed(() => this.triggerIdsBeingWritten().includes(this.selectedId() ?? ''));
  protected readonly draftProblem = computed(() => { const draft = this.draft(); return draft === undefined ? undefined : problemOfDraft(draft); });

  protected readonly unconfirmedState = computed(() => this.unconfirmedStates().find((state) => state.triggerId === this.selectedId()));
  protected readonly isSavedNoticeShown = computed(() => this.savedTriggerId() !== undefined && this.savedTriggerId() === this.selectedId());

  /** A field read in full stays read for this exact content only: another trigger or another revision starts unread. */
  private readonly reviewScope = computed(() => {
    const trigger = this.selected();
    return trigger === undefined ? '' : `${trigger.id}@${trigger.contentRev}@${trigger.reviewDigest}`;
  });
  private readonly review = computed(() => {
    const trigger = this.selected();
    return trigger === undefined ? { fields: [], unreadable: [] } : approvalReviewOf(trigger);
  });
  protected readonly reviewRows = computed(() => {
    const readInFull = this.readInFullFieldIds();
    return this.review().fields.map((field) => {
      const isReadInFull = readInFull.has(this.fieldId(field.key));
      const { shownText, hiddenChars } = isReadInFull ? { shownText: field.text, hiddenChars: 0 } : previewOf(field.text);
      const isCutAndUnread = hiddenChars > 0;
      return { key: field.key, label: field.label, shownText, hiddenChars, isCutAndUnread };
    });
  });
  protected readonly armBlockedReason = computed(() => {
    const unreadable = this.review().unreadable;
    const cutLabels = this.reviewRows().filter((row) => row.isCutAndUnread).map((row) => row.label);
    const reasons = [
      unreadable.length > 0 ? `Armement impossible : cet écran ne sait pas afficher ${unreadable.join(', ')}.` : undefined,
      cutLabels.length > 0 ? `Armer demande de tout lire : ${cutLabels.join(', ')}.` : undefined,
    ].filter((reason) => reason !== undefined);
    return reasons.length === 0 ? undefined : reasons.join(' ');
  });

  protected readonly whenText = whenText;
  protected readonly runText = runText;
  protected readonly conditionText = conditionText;

  private latestListRequest = 0;
  private latestFiresRequest = 0;
  private latestManagersRequest = 0;

  constructor() {
    effect(() => {
      this.projectId();
      untracked(() => {
        this.latestFiresRequest += 1;
        this.selectedId.set(undefined);
        this.unconfirmedStates.set([]);
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
      if (request === this.latestListRequest) this.showList(items);
    } catch (error) {
      if (request === this.latestListRequest) this.triggers.set(failedLoadOf(error));
    }
  }

  /** A list just read is the truth about every trigger in it, so no state stays unconfirmed. */
  private showList(items: TriggerView[]): void {
    this.triggers.set({ status: 'loaded', value: items });
    this.unconfirmedStates.set([]);
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
    this.savedTriggerId.set(undefined);
    this.closeDraft();
  }

  /** A list of managers asked for by a form that is closed belongs to no form: its answer is ignored. */
  private closeDraft(): void {
    this.latestManagersRequest += 1;
    this.draft.set(undefined);
  }

  protected async loadManagers(): Promise<void> {
    const request = ++this.latestManagersRequest;
    this.managers.set(LOADING);
    try {
      const sessions = await this.api.listSessions();
      if (request === this.latestManagersRequest) this.managers.set({ status: 'loaded', value: ownerChoicesOf({ sessions, projectId: this.projectId() }) });
    } catch (error) {
      if (request === this.latestManagersRequest) this.managers.set(failedLoadOf(error));
    }
  }

  protected arm(reviewed: TriggerView): Promise<void> {
    return this.performWrite({ triggerId: reviewed.id, mayBeArmedAfterwards: true }, async () => {
      const current = await this.api.getTrigger(reviewed.id);
      if (hasMovedSinceReview({ reviewed, current })) throw reviewedRuleHasMoved();
      const humanProof = await this.nonceMinter.mintTriggerArmingNonce(reviewed.id);
      await this.api.armTrigger({ triggerId: reviewed.id, approvedRev: reviewed.contentRev, humanProof });
    });
  }

  protected disarm(trigger: TriggerView): Promise<void> {
    return this.performWrite({ triggerId: trigger.id, mayBeArmedAfterwards: true }, async () => { await this.api.disarmTrigger(trigger.id); });
  }

  /** Reads the list again for a trigger whose state is unknown; a list that cannot be read keeps it unknown and says so. */
  protected async recheck(): Promise<void> {
    const selectionAtStart = this.latestFiresRequest;
    const refresh = await this.refreshTriggers();
    const isStillOnSelectionAtStart = selectionAtStart === this.latestFiresRequest;
    if (refresh.confirmed || !isStillOnSelectionAtStart) return;
    this.writeFailure.set({ message: copyFor(refresh.error, { action: 'generic' }).text });
    this.focusAfterRender(this.writeAlert);
  }

  protected readAll(fieldKey: string): void {
    this.readInFullFieldIds.update((ids) => new Set(ids).add(this.fieldId(fieldKey)));
  }

  private fieldId(fieldKey: string): string {
    return `${this.reviewScope()}|${fieldKey}`;
  }

  protected startEditing(trigger: TriggerView): void {
    this.writeFailure.set(undefined);
    this.savedTriggerId.set(undefined);
    this.draft.set(draftOf(trigger));
    void this.loadManagers();
  }

  protected cancelEdit(): void {
    this.closeDraft();
    this.focusAfterRender(this.triggerHeading);
  }

  protected editDraft(change: Partial<TriggerEditDraft>): void {
    this.draft.update((draft) => (draft === undefined ? draft : { ...draft, ...change }));
  }

  /** The change is merged into the WHEN the draft holds now, never into the one a child saw when it last rendered. */
  protected editWhen(change: Partial<WhenDraft>): void {
    this.draft.update((draft) => (draft?.when === undefined ? draft : { ...draft, when: { ...draft.when, ...change } }));
  }

  protected chooseOwner(chosenValue: string): void {
    const choices = loadedValueOf(this.managers()) ?? [];
    this.draft.update((draft) => {
      const accepted = draft === undefined ? undefined : acceptedOwnerOf({ chosenValue, choices, openedWith: draft.openedWithOwnerManagerId });
      return draft === undefined || accepted === undefined ? draft : { ...draft, ownerManagerId: accepted.owner };
    });
  }

  protected submitEdit(event: Event, trigger: TriggerView): Promise<void> {
    event.preventDefault();
    const draft = this.draft();
    const hasNothingToSave = draft === undefined || problemOfDraft(draft) !== undefined;
    if (hasNothingToSave) return Promise.resolve();
    const target = { triggerId: trigger.id, mayBeArmedAfterwards: trigger.armedAt !== null };
    return this.performWrite(target, async () => {
      await this.api.updateTrigger({ triggerId: trigger.id, expectedRev: draft.openedAtRev, changes: changesOf(draft) });
      this.savedTriggerId.set(trigger.id);
    });
  }

  /**
   * Runs one write on a trigger, then reads the list again so the screen shows what the daemon holds.
   * Only the trigger still chosen when the answer comes back gets the focus, the refusal or the closed form.
   * A write the daemon accepted whose list cannot be read leaves the trigger in an unconfirmed state, whatever is chosen by then.
   */
  private async performWrite({ triggerId, mayBeArmedAfterwards }: WriteTarget, write: () => Promise<void>): Promise<void> {
    if (this.triggerIdsBeingWritten().includes(triggerId)) return;
    const selectionAtStart = this.latestFiresRequest;
    const isStillOnSelectionAtStart = () => selectionAtStart === this.latestFiresRequest;
    this.triggerIdsBeingWritten.update((ids) => [...ids, triggerId]);
    this.writeFailure.set(undefined);
    try {
      await write();
      const refresh = await this.refreshTriggers();
      if (!refresh.confirmed) this.unconfirmedStates.update((states) => [...states.filter((state) => state.triggerId !== triggerId), { triggerId, mayBeArmed: mayBeArmedAfterwards }]);
      if (!isStillOnSelectionAtStart()) return;
      this.closeDraft();
      this.focusAfterRender(this.triggerHeading);
    } catch (error) {
      const isReloadAdvised = retryOfError(error) === 'after_refresh';
      if (isReloadAdvised) await this.refreshTriggers();
      if (!isStillOnSelectionAtStart()) return;
      if (isReloadAdvised) this.closeDraft();
      this.writeFailure.set({ message: copyFor(error, { action: 'generic' }).text });
      this.focusAfterRender(this.writeAlert);
    } finally {
      this.triggerIdsBeingWritten.update((ids) => ids.filter((id) => id !== triggerId));
    }
  }

  /** Replaces the list without the loading state, so the trigger on screen stays; a project chosen since owns its own list. */
  private async refreshTriggers(): Promise<ListRefresh> {
    const request = ++this.latestListRequest;
    try {
      const items = await this.api.listTriggers(this.projectId());
      if (request === this.latestListRequest) this.showList(items);
      return { confirmed: true };
    } catch (error) {
      return { confirmed: false, error };
    }
  }

  private focusAfterRender(target: Signal<ElementRef<HTMLElement> | undefined>): void {
    afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }

  protected pillStateOf(trigger: TriggerView): PillState { return this.isStateUnconfirmed(trigger) ? 'unknown' : armingStateOf(trigger); }
  protected pillLabelOf(trigger: TriggerView): string { return PILL_LABELS[this.pillStateOf(trigger)]; }
  protected rowStateLabelOf(trigger: TriggerView): string {
    if (this.isStateUnconfirmed(trigger)) return 'État inconnu';
    return trigger.armedAt === null ? 'Désarmé' : 'Armé';
  }

  private isStateUnconfirmed(trigger: TriggerView): boolean { return this.unconfirmedStates().some((state) => state.triggerId === trigger.id); }

  protected ledgerLabel(fire: TriggerFireView): string { return LEDGER_STATE_LABELS[fire.ledgerState]; }
  protected reasonLabel(fire: TriggerFireView): string { return fire.reason === null ? '' : FIRE_REASON_LABELS[fire.reason]; }

  protected armingText(trigger: TriggerView): string {
    if (this.isStateUnconfirmed(trigger)) return '';
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
