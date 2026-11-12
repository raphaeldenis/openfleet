import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, inject, input, output, viewChild } from '@angular/core';
import { escapedControlsOf } from '@openfleet/shared';
import { loadedValueOf, type Load } from './load-state';
import type { OwnerChoice } from './owner-choices';
import { BACKLOG_POLICIES, BATCH_MODES, type TriggerEditDraft } from './trigger-edit-draft';
import { CRON_CATCH_UPS, INTEGRATION_EVENTS, ROW_COUNT_OPS, SESSION_STATES, STORE_EVENTS, WHEN_SOURCES, type WhenDraft } from './when-draft';

const SOURCE_LABELS: Record<WhenDraft['source'], string> = {
  session_state: 'État d’une session enfant', silent_run: 'Session enfant silencieuse', data_store_query: 'Table de données', cron: 'Horaire (cron)', integration_records: 'Enregistrements d’une intégration',
};

const valueOf = (event: Event) => (event.target as HTMLInputElement).value;

/** The form that edits a trigger: title, WHEN, owner and policy. It holds nothing: the draft comes in, every change goes out, and the panel owns the state. */
@Component({
  selector: 'of-trigger-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="editor" aria-label="Modifier le trigger" data-testid="trigger-editor" (submit)="submitted.emit($event)">
      <p class="muted">Enregistrer désarme le trigger : il faudra relire la règle et l’armer de nouveau.</p>
      <label>Titre <input #titleField type="text" [value]="draft().title" (input)="draftChange.emit({ title: valueOf($event) })" /></label>

      <fieldset>
        <legend>Quand</legend>
        @if (draft().when; as when) {
          <label>Source
            <select (change)="whenChange.emit({ source: sourceOf($event) })">
              @for (source of sources; track source) { <option [value]="source" [selected]="source === when.source">{{ sourceLabels[source] }}</option> }
            </select>
          </label>
          @switch (when.source) {
            @case ('session_state') {
              <label>État de la session
                <select (change)="whenChange.emit({ sessionState: sessionStateOf($event) })">
                  @for (state of sessionStates; track state) { <option [value]="state" [selected]="state === when.sessionState">{{ state }}</option> }
                </select>
              </label>
              @if (when.sessionState !== 'closed_with_error') {
                <label>Minutes <input type="text" inputmode="numeric" [value]="when.minutes" [attr.aria-describedby]="describedBy()" (input)="whenChange.emit({ minutes: valueOf($event) })" /></label>
              }
            }
            @case ('silent_run') {
              <label>Minutes <input type="text" inputmode="numeric" [value]="when.minutes" [attr.aria-describedby]="describedBy()" (input)="whenChange.emit({ minutes: valueOf($event) })" /></label>
            }
            @case ('data_store_query') {
              <label>Identifiant de la table <input type="text" [value]="when.storeId" [attr.aria-describedby]="describedBy()" (input)="whenChange.emit({ storeId: valueOf($event) })" /></label>
              <label>Événement de la table
                <select (change)="whenChange.emit({ storeEvent: storeEventOf($event) })">
                  @for (event of storeEvents; track event) { <option [value]="event" [selected]="event === when.storeEvent">{{ event }}</option> }
                </select>
              </label>
              @if (when.storeEvent === 'row_count') {
                <label>Opérateur
                  <select (change)="whenChange.emit({ rowCountOp: rowCountOpOf($event) })">
                    @for (op of rowCountOps; track op) { <option [value]="op" [selected]="op === when.rowCountOp">{{ op }}</option> }
                  </select>
                </label>
                <label>Seuil <input type="text" inputmode="numeric" [value]="when.rowCountThreshold" [attr.aria-describedby]="describedBy()" (input)="whenChange.emit({ rowCountThreshold: valueOf($event) })" /></label>
              }
            }
            @case ('cron') {
              <label>Expression cron <input type="text" [value]="when.expression" [attr.aria-describedby]="describedBy()" (input)="whenChange.emit({ expression: valueOf($event) })" /></label>
              <label>Fuseau horaire <input type="text" [value]="when.timezone" [attr.aria-describedby]="describedBy()" (input)="whenChange.emit({ timezone: valueOf($event) })" /></label>
              <label>Rattrapage
                <select (change)="whenChange.emit({ catchUp: catchUpOf($event) })">
                  @for (catchUp of catchUps; track catchUp) { <option [value]="catchUp" [selected]="catchUp === when.catchUp">{{ catchUp }}</option> }
                </select>
              </label>
            }
            @case ('integration_records') {
              <label>Identifiant de l'intégration <input type="text" [value]="when.itemId" [attr.aria-describedby]="describedBy()" (input)="whenChange.emit({ itemId: valueOf($event) })" /></label>
              <label>Événement de l'intégration
                <select (change)="whenChange.emit({ integrationEvent: integrationEventOf($event) })">
                  @for (event of integrationEvents; track event) { <option [value]="event" [selected]="event === when.integrationEvent">{{ event }}</option> }
                </select>
              </label>
              @if (when.integrationEvent === 'field_changed') {
                <label>Champ suivi <input type="text" [value]="when.trackedField" [attr.aria-describedby]="describedBy()" (input)="whenChange.emit({ trackedField: valueOf($event) })" /></label>
              }
            }
          }
        } @else {
          <p class="muted" data-testid="when-not-editable">Ce déclencheur n’est pas modifiable ici : il reste tel qu’il est enregistré.</p>
        }
      </fieldset>

      <label>Propriétaire
        <select [disabled]="!ownerChoices()" (change)="ownerChosen.emit(valueOf($event))">
          <option value="" [selected]="draft().ownerManagerId === null">Aucun manager</option>
          @for (choice of ownerOptions(); track choice.id) { <option [value]="choice.id" [selected]="choice.id === draft().ownerManagerId">{{ choice.label }}</option> }
        </select>
      </label>
      @switch (managers().status) {
        @case ('loading') { <span class="muted" role="status">Chargement des managers…</span> }
        @case ('failed') {
          <span class="error" data-testid="owner-unavailable">Les managers du projet sont indisponibles : le propriétaire reste tel qu’il est enregistré.</span>
          <button type="button" class="of-btn of-btn--compact" (click)="managersRetried.emit()">Réessayer les managers</button>
        }
      }

      <label>Repos (secondes) <input type="text" inputmode="numeric" [value]="draft().cooldownSeconds" [attr.aria-describedby]="describedBy()" (input)="draftChange.emit({ cooldownSeconds: valueOf($event) })" /></label>
      <label>Plafond de tirs par jour <input type="text" inputmode="numeric" [value]="draft().maxFiresPerDay" [attr.aria-describedby]="describedBy()" (input)="draftChange.emit({ maxFiresPerDay: valueOf($event) })" /></label>
      <span class="muted">Un plafond vide laisse le trigger sans plafond journalier.</span>
      <label>Mode de lot
        <select (change)="draftChange.emit({ batchMode: batchModeOf($event) })">
          @for (mode of batchModes; track mode) { <option [value]="mode" [selected]="mode === draft().batchMode">{{ mode }}</option> }
        </select>
      </label>
      <label>Arriéré
        <select (change)="draftChange.emit({ backlogPolicy: backlogPolicyOf($event) })">
          @for (policy of backlogPolicies; track policy) { <option [value]="policy" [selected]="policy === draft().backlogPolicy">{{ policy }}</option> }
        </select>
      </label>
      @if (problem(); as text) { <p id="editor-problem" class="error" data-testid="editor-problem">{{ text }}</p> }
      <div class="actions">
        <button type="submit" class="of-btn of-btn--compact" [disabled]="problem() !== undefined || isWriting()">Enregistrer</button>
        <button type="button" class="of-btn of-btn--compact" (click)="cancelled.emit()">Annuler</button>
      </div>
    </form>
  `,
  styles: `
    .editor { display: flex; flex-direction: column; align-items: flex-start; gap: .5rem; }
    .editor label { display: flex; flex-direction: column; gap: .125rem; }
    fieldset { display: flex; flex-direction: column; gap: .5rem; border: 1px solid var(--line); border-radius: .5rem; padding: .5rem .75rem; margin: 0; }
    .muted { color: var(--mut); font-size: .8125rem; }
    .error { color: var(--state-error); margin: 0; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
  `,
})
export class TriggerEditorComponent {
  readonly draft = input.required<TriggerEditDraft>();
  readonly problem = input<string | undefined>(undefined);
  readonly managers = input.required<Load<OwnerChoice[]>>();
  readonly isWriting = input(false);

  readonly draftChange = output<Partial<TriggerEditDraft>>();
  readonly whenChange = output<Partial<WhenDraft>>();
  readonly ownerChosen = output<string>();
  readonly managersRetried = output<void>();
  readonly submitted = output<Event>();
  readonly cancelled = output<void>();

  protected readonly sources = WHEN_SOURCES;
  protected readonly sourceLabels = SOURCE_LABELS;
  protected readonly sessionStates = SESSION_STATES;
  protected readonly storeEvents = STORE_EVENTS;
  protected readonly rowCountOps = ROW_COUNT_OPS;
  protected readonly catchUps = CRON_CATCH_UPS;
  protected readonly integrationEvents = INTEGRATION_EVENTS;
  protected readonly batchModes = BATCH_MODES;
  protected readonly backlogPolicies = BACKLOG_POLICIES;
  protected readonly valueOf = valueOf;

  protected readonly describedBy = computed(() => (this.problem() === undefined ? null : 'editor-problem'));
  protected readonly ownerChoices = computed(() => loadedValueOf(this.managers()));

  /** The managers of the project, then the owner the form was opened with when the project does not list it, named as such. */
  protected readonly ownerOptions = computed<OwnerChoice[]>(() => {
    const loadedChoices = this.ownerChoices();
    const choices = loadedChoices ?? [];
    const openedOwner = this.draft().openedWithOwnerManagerId;
    const isOpenedOwnerListed = openedOwner === null || choices.some((choice) => choice.id === openedOwner);
    if (isOpenedOwnerListed) return choices;
    const whyUnlisted = loadedChoices === undefined ? 'propriétaire enregistré' : 'introuvable parmi les managers du projet';
    return [...choices, { id: openedOwner, label: `${escapedControlsOf(openedOwner)} — ${whyUnlisted}` }];
  });

  private readonly titleField = viewChild.required<ElementRef<HTMLInputElement>>('titleField');

  constructor() {
    afterNextRender(() => this.titleField().nativeElement.focus(), { injector: inject(Injector) });
  }

  protected sourceOf(event: Event) { return valueOf(event) as WhenDraft['source']; }
  protected sessionStateOf(event: Event) { return valueOf(event) as WhenDraft['sessionState']; }
  protected storeEventOf(event: Event) { return valueOf(event) as WhenDraft['storeEvent']; }
  protected rowCountOpOf(event: Event) { return valueOf(event) as WhenDraft['rowCountOp']; }
  protected catchUpOf(event: Event) { return valueOf(event) as WhenDraft['catchUp']; }
  protected integrationEventOf(event: Event) { return valueOf(event) as WhenDraft['integrationEvent']; }
  protected batchModeOf(event: Event) { return valueOf(event) as TriggerEditDraft['batchMode']; }
  protected backlogPolicyOf(event: Event) { return valueOf(event) as TriggerEditDraft['backlogPolicy']; }
}
