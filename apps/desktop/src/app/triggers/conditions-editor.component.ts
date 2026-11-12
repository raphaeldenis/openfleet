import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, inject, input, output, viewChild } from '@angular/core';
import { escapedControlsDeep, type TriggerWhenSource } from '@openfleet/shared';
import {
  CONDITION_JOINS, CONDITION_LIMIT, CONDITION_OPERATORS, VALUE_KINDS, canAddCondition, effectiveNamespaceOf, namespacesOf, needsValue,
  type ConditionChange, type ConditionDraft, type EditableConditionDraft, type ValueKind,
} from './conditions-draft';

const VALUE_KIND_LABELS: Record<ValueKind, string> = { text: 'Texte', number: 'Nombre', boolean: 'Booléen' };
const JOIN_LABELS: Record<(typeof CONDITION_JOINS)[number], string> = { and: 'et', or: 'ou' };

const valueOf = (event: Event) => (event.target as HTMLInputElement).value;
const FOCUS_TARGET = '[data-focus-target]';

/** The list of conditions of a trigger: the drafts come in, every change goes out as one small event, and the panel owns the state. */
@Component({
  selector: 'of-conditions-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="conditions" data-testid="conditions-editor">
      <legend>Conditions</legend>
      <p class="muted" role="status" data-testid="conditions-counter">{{ conditions().length }}/{{ limit }} conditions</p>
      <ol class="list">
        @for (condition of conditions(); track condition.key; let position = $index; let isFirst = $first) {
          <li class="condition" tabindex="-1" role="group" [attr.aria-label]="'Condition ' + (position + 1)">
            @if (condition.kind === 'opaque') {
              <span class="muted" data-testid="condition-not-editable">Cette condition n’est pas modifiable ici : elle reste telle qu’elle est enregistrée. {{ plainTextOf(condition.stored) }}</span>
            } @else {
              @if (!isFirst) {
                <label>Jointure
                  <select [attr.aria-label]="'Jointure de la condition ' + (position + 1)" (change)="conditionChange.emit({ key: condition.key, change: { join: joinOf($event) } })">
                    @for (join of joins; track join) { <option [value]="join" [selected]="join === condition.join">{{ joinLabels[join] }}</option> }
                  </select>
                </label>
              }
              @if (namespacesOfSource().length > 1) {
                <select [attr.aria-label]="'Espace de la condition ' + (position + 1)" (change)="conditionChange.emit({ key: condition.key, change: { namespace: valueOf($event) } })">
                  @for (namespace of namespacesOfSource(); track namespace) { <option [value]="namespace" [selected]="namespace === namespaceOf(condition)">{{ namespace }}</option> }
                </select>
              } @else {
                <span class="namespace" [attr.data-testid]="'condition-namespace-' + (position + 1)">{{ namespaceOf(condition) }}</span>
              }
              <input data-focus-target type="text" [attr.aria-label]="'Chemin de la condition ' + (position + 1)" [value]="condition.path" (input)="conditionChange.emit({ key: condition.key, change: { path: valueOf($event) } })" />
              <select [attr.aria-label]="'Opérateur de la condition ' + (position + 1)" (change)="conditionChange.emit({ key: condition.key, change: { op: operatorOf($event) } })">
                @for (op of operators; track op) { <option [value]="op" [selected]="op === condition.op">{{ op }}</option> }
              </select>
              @if (needsValue(condition.op)) {
                <select [attr.aria-label]="'Type de la valeur de la condition ' + (position + 1)" (change)="conditionChange.emit({ key: condition.key, change: { valueKind: valueKindOf($event) } })">
                  @for (kind of valueKinds; track kind) { <option [value]="kind" [selected]="kind === condition.valueKind">{{ valueKindLabels[kind] }}</option> }
                </select>
                @if (condition.valueKind === 'boolean') {
                  <select [attr.aria-label]="'Valeur de la condition ' + (position + 1)" (change)="conditionChange.emit({ key: condition.key, change: { valueText: valueOf($event) } })">
                    <option value="true" [selected]="condition.valueText === 'true'">vrai</option>
                    <option value="false" [selected]="condition.valueText !== 'true'">faux</option>
                  </select>
                } @else {
                  <input type="text" [attr.aria-label]="'Valeur de la condition ' + (position + 1)" [value]="condition.valueText" (input)="conditionChange.emit({ key: condition.key, change: { valueText: valueOf($event) } })" />
                }
              }
              <label class="check"><input type="checkbox" [attr.aria-label]="'Ignorer la casse de la condition ' + (position + 1)" [checked]="condition.caseInsensitive" (change)="conditionChange.emit({ key: condition.key, change: { caseInsensitive: checkedOf($event) } })" /> Ignorer la casse</label>
              <button type="button" class="of-btn of-btn--compact" [attr.aria-label]="'Supprimer la condition ' + (position + 1)" (click)="remove({ key: condition.key, position })">Supprimer</button>
            }
          </li>
        }
      </ol>
      <button #addButton type="button" class="of-btn of-btn--compact" [disabled]="!canAdd()" (click)="add()">Ajouter une condition</button>
      @if (isFull()) { <span class="muted" data-testid="conditions-full">{{ limit }} conditions au plus.</span> }
    </fieldset>
  `,
  styles: `
    .conditions { display: flex; flex-direction: column; align-items: flex-start; gap: .5rem; border: 1px solid var(--line); border-radius: .5rem; padding: .5rem .75rem; margin: 0; }
    .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
    .condition { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    .check { display: inline-flex; align-items: center; gap: .25rem; }
    .namespace { color: var(--mut); font-family: monospace; }
    .muted { color: var(--mut); font-size: .8125rem; margin: 0; }
  `,
})
export class ConditionsEditorComponent {
  readonly conditions = input.required<readonly ConditionDraft[]>();
  readonly source = input.required<TriggerWhenSource | undefined>();

  readonly conditionAdded = output<void>();
  readonly conditionRemoved = output<string>();
  readonly conditionChange = output<{ key: string; change: ConditionChange }>();

  protected readonly limit = CONDITION_LIMIT;
  protected readonly joins = CONDITION_JOINS;
  protected readonly joinLabels = JOIN_LABELS;
  protected readonly operators = CONDITION_OPERATORS;
  protected readonly valueKinds = VALUE_KINDS;
  protected readonly valueKindLabels = VALUE_KIND_LABELS;
  protected readonly needsValue = needsValue;
  protected readonly valueOf = valueOf;

  protected readonly namespacesOfSource = computed(() => namespacesOf(this.source()));
  protected readonly isFull = computed(() => !canAddCondition(this.conditions()));
  protected readonly canAdd = computed(() => !this.isFull() && this.namespacesOfSource().length > 0);

  private readonly addButton = viewChild.required<ElementRef<HTMLElement>>('addButton');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected namespaceOf(condition: EditableConditionDraft): string { return effectiveNamespaceOf({ condition, source: this.source() }); }
  protected plainTextOf(stored: object): string { return JSON.stringify(escapedControlsDeep(stored)); }

  protected add(): void {
    this.conditionAdded.emit();
    this.focusAfterRender((rows) => rows.at(-1));
  }

  protected remove({ key, position }: { key: string; position: number }): void {
    this.conditionRemoved.emit(key);
    this.focusAfterRender((rows) => rows[Math.min(position, rows.length - 1)]);
  }

  /** Once the list is drawn again, the focus goes to the row the chooser picks, or to the add button when no row is left. */
  private focusAfterRender(chooseRow: (rows: HTMLElement[]) => HTMLElement | undefined): void {
    afterNextRender(() => {
      const rows = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('li.condition'));
      const row = chooseRow(rows);
      const target = row?.querySelector<HTMLElement>(FOCUS_TARGET) ?? row ?? this.addButton().nativeElement;
      target.focus();
    }, { injector: this.injector });
  }

  protected joinOf(event: Event) { return valueOf(event) as EditableConditionDraft['join']; }
  protected operatorOf(event: Event) { return valueOf(event) as EditableConditionDraft['op']; }
  protected valueKindOf(event: Event) { return valueOf(event) as ValueKind; }
  protected checkedOf(event: Event) { return (event.target as HTMLInputElement).checked; }
}
