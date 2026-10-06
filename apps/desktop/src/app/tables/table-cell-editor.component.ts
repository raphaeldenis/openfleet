import { afterNextRender, ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import type { DsColumn } from '@openfleet/shared';
import { displayValue } from './table-cells';
import { editedCellValue } from './table-cell-editor-values';

@Component({
  selector: 'of-table-cell-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop">
      <section #dialog tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="cell-editor-title" (keydown)="handleKey($event)">
        <h2 id="cell-editor-title">Edit {{ column().displayName }} — {{ rowTitle() }}</h2>
        <form novalidate (submit)="$event.preventDefault(); save()">
          <label for="cell-editor-input">{{ column().displayName }}</label>
          @if (column().format === 'longText') {
            <textarea id="cell-editor-input" [value]="draft()" [disabled]="saving()" [attr.aria-invalid]="validationError() ? 'true' : null" aria-describedby="cell-editor-help cell-editor-error" (input)="changeDraft($any($event.target).value)"></textarea>
          } @else {
            <input id="cell-editor-input" [type]="inputType()" step="any" [value]="draft()" [disabled]="saving()" [attr.aria-invalid]="validationError() ? 'true' : null" aria-describedby="cell-editor-help cell-editor-error" (input)="changeDraft($any($event.target).value)" />
          }
          <p id="cell-editor-help">{{ help() }}</p>
          @if (column().format === 'datetime' && localPreview()) { <p>Local time: {{ localPreview() }}</p> }
          @if (clearsValue()) { <p role="status">The value will be cleared.</p> }
          <p id="cell-editor-error" role="alert">{{ validationError() || error() }}</p>
          <div class="actions">
            <button type="button" [disabled]="saving()" (click)="clearValue()">Clear value</button>
            <button type="button" [disabled]="saving()" (click)="cancelled.emit()">Cancel</button>
            <button type="submit" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save' }}</button>
          </div>
          @if (saving()) { <span role="status">Saving…</span> }
        </form>
      </section>
    </div>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; z-index: 100; background: #0008; display: flex; align-items: center; justify-content: center; padding: 1rem }
    section { display: flex; flex-direction: column; width: 32rem; max-width: 100%; max-height: 90vh; overflow: auto; padding: 1rem; border-radius: .5rem; background: var(--panel); color: var(--fg) }
    h2 { font-size: 1rem; margin: 0 0 1rem }
    form { display: flex; flex-direction: column; gap: .5rem }
    input, textarea { box-sizing: border-box; width: 100%; padding: .5rem; font: inherit; color: inherit; background: var(--sunk); border: .0625rem solid var(--line); border-radius: .25rem }
    textarea { min-height: 12rem; resize: vertical }
    p { margin: 0; font-size: .75rem; overflow-wrap: anywhere }
    #cell-editor-error { color: var(--s-err) }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; justify-content: flex-end }
    button { padding: .375rem .625rem; font: inherit; cursor: pointer }
    :is(input, textarea, button):focus-visible { outline: .125rem solid var(--accent); outline-offset: .125rem }
  `,
})
export class TableCellEditorComponent {
  readonly column = input.required<DsColumn>();
  readonly initialValue = input.required<unknown>();
  readonly rowTitle = input.required<string>();
  readonly saving = input(false);
  readonly error = input<string | null>(null);
  readonly submitted = output<unknown>();
  readonly cancelled = output<void>();
  private readonly dialog = viewChild.required<ElementRef<HTMLElement>>('dialog');
  protected readonly draft = signal('');
  protected readonly clearsValue = signal(false);
  protected readonly validationError = signal<string | null>(null);
  protected readonly inputType = computed(() => this.column().format === 'rank' ? 'number' : this.column().format === 'url' ? 'url' : 'text');
  protected readonly help = computed(() => {
    if (this.column().format === 'datetime') return 'ISO date and time with timezone, for example 2026-10-06T10:09:10+02:00.';
    if (this.column().format === 'longText') return 'Plain text, up to 64 KiB. Ctrl or Command + Enter saves.';
    if (this.column().format === 'url') return 'An absolute HTTP or HTTPS URL, or empty text.';
    return 'Any finite number. Use Clear value to remove it.';
  });
  protected readonly localPreview = computed(() => {
    const result = editedCellValue(this.column(), this.draft());
    return result.error || this.clearsValue() ? '' : displayValue(this.column(), result.value);
  });

  constructor() {
    afterNextRender(() => {
      const value = this.initialValue();
      this.draft.set(value === null || value === undefined ? '' : String(value));
      this.dialog().nativeElement.querySelector<HTMLElement>('input, textarea')?.focus();
    });
  }

  protected changeDraft(value: string): void {
    this.draft.set(value);
    this.clearsValue.set(false);
    this.validationError.set(null);
  }

  protected clearValue(): void {
    this.clearsValue.set(true);
    this.validationError.set(null);
  }

  protected save(): void {
    if (this.saving()) return;
    const result = this.clearsValue() ? { value: null, error: null } : editedCellValue(this.column(), this.draft());
    this.validationError.set(result.error);
    if (!result.error) this.submitted.emit(result.value);
  }

  protected handleKey(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!this.saving()) this.cancelled.emit();
      return;
    }
    if (this.isSaveShortcut(event)) {
      event.preventDefault();
      this.save();
      return;
    }
    if (event.key === 'Tab') this.containTabFocus(event);
  }

  private isSaveShortcut(event: KeyboardEvent): boolean {
    const isTextArea = event.target instanceof HTMLTextAreaElement;
    const savesTextArea = isTextArea && event.key === 'Enter' && (event.ctrlKey || event.metaKey);
    const savesInput = event.target instanceof HTMLInputElement && event.key === 'Enter';
    return savesTextArea || savesInput;
  }

  private containTabFocus(event: KeyboardEvent): void {
    const controls = Array.from(this.dialog().nativeElement.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)'));
    if (controls.length === 0) {
      event.preventDefault();
      this.dialog().nativeElement.focus();
      return;
    }
    const targetIndex = controls.indexOf(document.activeElement as HTMLElement);
    if (targetIndex === -1) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      return;
    }
    const leavesStart = event.shiftKey && targetIndex === 0;
    const leavesEnd = !event.shiftKey && targetIndex === controls.length - 1;
    if (!leavesStart && !leavesEnd) return;
    event.preventDefault();
    (leavesStart ? controls.at(-1) : controls[0])?.focus();
  }
}
