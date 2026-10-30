import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { MAX_LAW_TEXT_CHARS, type LawSourceKind, type LawView } from '@openfleet/shared';
import { showBidiControlsAsEscapes } from '../core/bidi-escapes';
import { copyFor } from '../core/error-copy';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { compactElapsedLabel, elapsedSecondsSince } from '../design/elapsed-time';
import { ErrorLineComponent } from '../design/error-line.component';
import { tickingNow } from '../working-state/working-state-freshness';

const LAW_CHANGED_COPY = 'This law changed since you opened it. Reload it.';
const LAW_REVISION_CONFLICT_CODE = 'law_revision_conflict';
const EXCERPT_CHARS = 60;
const PROVENANCE_LABELS: Record<LawSourceKind, string> = { proposal: 'Approved proposal', legacy: 'Earlier approval', import: 'Imported' };

const excerptOf = (text: string): string => (text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text);

interface Editing {
  readonly lawId: string;
  readonly draft: string;
  /** The revision the human was reading when the edit began. */
  readonly openedRevision: number;
  /** The revision the save is checked against: the opened one, until a reload after a conflict shows the human the current text. */
  readonly basisRevision: number;
}

/** The laws of one manager: the active ones a human edits or withdraws, and the withdrawn ones kept as history. */
@Component({
  selector: 'of-manager-laws',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent],
  template: `
    <div data-testid="manager-governance-laws">
      <h3 class="subtitle">Laws</h3>
      @if (activeLaws().length === 0) {
        <p class="muted">No active law.</p>
      }
      <ul class="entries">
        @for (law of activeLaws(); track law.id) {
          <li class="entry" data-testid="manager-law" [attr.data-law-id]="law.id">
            @if (editing(); as edit) {
              @if (edit.lawId === law.id) {
                <div class="editor" role="group" [attr.aria-label]="'Edit law: ' + law.excerpt" (keydown.escape)="cancelEdit()">
                  <label class="field-label" [for]="'law-text-' + law.id">Law text</label>
                  <textarea
                    #draftField
                    class="draft"
                    rows="3"
                    [id]="'law-text-' + law.id"
                    [attr.maxlength]="maxLawChars"
                    [attr.aria-describedby]="'law-hint-' + law.id"
                    [value]="edit.draft"
                    (input)="updateDraft($any($event.target).value)"
                  ></textarea>
                  <p class="hint" [id]="'law-hint-' + law.id">1 to {{ maxLawChars }} characters.</p>
                  @if (law.revision !== edit.openedRevision) {
                    <p class="changed" data-testid="manager-law-current">
                      <span class="changed-label">Now reads (revision {{ law.revision }})</span>
                      <span class="summary">{{ law.text }}</span>
                    </p>
                  }
                  <div class="actions">
                    <button type="button" class="of-btn of-btn--primary" [disabled]="isDraftBlank() || isSaving()" (click)="saveEdit(law)">Save law</button>
                    <button type="button" class="of-btn of-btn--secondary" (click)="cancelEdit()">Cancel</button>
                  </div>
                </div>
              } @else {
                <span class="summary">{{ law.text }}</span>
              }
            } @else {
              <span class="summary">{{ law.text }}</span>
            }
            <span class="meta">Revision {{ law.revision }} · {{ law.provenance }} · updated {{ law.ageLabel }} ago</span>
            @if (withdrawingId() === law.id) {
              <div class="actions" role="group" [attr.aria-label]="'Withdraw law: ' + law.excerpt" (keydown.escape)="cancelWithdrawal()">
                <span class="confirm-question">Withdraw this law? The manager stops following it.</span>
                <button type="button" class="of-btn of-btn--primary" [disabled]="isSaving()" (click)="confirmWithdrawal(law)">Confirm withdrawal</button>
                <button type="button" class="of-btn of-btn--secondary" (click)="cancelWithdrawal()">Cancel</button>
              </div>
            } @else if (editing()?.lawId !== law.id) {
              <div class="actions">
                <button type="button" class="of-btn of-btn--secondary" [attr.aria-label]="'Edit law: ' + law.excerpt" (click)="startEdit(law)">Edit</button>
                <button type="button" class="of-btn of-btn--secondary" [attr.aria-label]="'Withdraw law: ' + law.excerpt" (click)="startWithdrawal(law.id)">Withdraw</button>
              </div>
            }
            @if (errorsById()[law.id]; as error) {
              <p role="alert"><of-error-line data-testid="manager-law-error" [glyph]="false">{{ error }}</of-error-line></p>
            }
          </li>
        }
      </ul>
    </div>
    @if (withdrawnLaws().length > 0) {
      <div data-testid="manager-governance-withdrawn-laws">
        <h3 class="subtitle">Withdrawn laws</h3>
        <ul class="entries">
          @for (law of withdrawnLaws(); track law.id) {
            <li class="entry">
              <span class="summary">{{ law.text }}</span>
              <span class="meta">Revision {{ law.revision }} · {{ law.provenance }} · withdrawn {{ law.withdrawnAgeLabel }} ago</span>
            </li>
          }
        </ul>
      </div>
    }
  `,
  styles: `
    :host { display: contents; }
    .subtitle { margin: 0 0 .25rem; font-size: .75rem; font-weight: 600; color: var(--mut); }
    .muted { margin: 0; font-size: .75rem; color: var(--mut); }
    .entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
    .entry { display: flex; flex-direction: column; gap: .25rem; min-width: 0; }
    .summary { white-space: pre-wrap; overflow-wrap: anywhere; }
    .meta { font-size: .75rem; color: var(--mut); }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    .confirm-question { font-size: .75rem; color: var(--mut); }
    .editor { display: flex; flex-direction: column; gap: .375rem; }
    .field-label { font-size: .75rem; font-weight: 500; }
    .draft { width: 100%; box-sizing: border-box; padding: .375rem .5rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); color: var(--fg); font: inherit; resize: vertical; }
    .draft:focus-visible { outline: .125rem solid var(--accent); outline-offset: .125rem; }
    .hint { margin: 0; font-size: .75rem; color: var(--mut); }
    .changed { display: flex; flex-direction: column; gap: .125rem; margin: 0; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--sunk); }
    .changed-label { font-size: .75rem; font-weight: 600; color: var(--mut); }
  `,
})
export class ManagerLawsComponent {
  readonly laws = input.required<readonly LawView[]>();
  /** Emitted when the laws shown are out of date: the parent reads them again. */
  readonly reloadRequested = output<void>();
  private readonly api = inject(FleetApiService);
  private readonly now = tickingNow();
  private readonly draftField = viewChild<ElementRef<HTMLTextAreaElement>>('draftField');
  protected readonly maxLawChars = MAX_LAW_TEXT_CHARS;
  protected readonly editing = signal<Editing | undefined>(undefined);
  protected readonly withdrawingId = signal<string | undefined>(undefined);
  protected readonly isSaving = signal(false);
  protected readonly errorsById = signal<Readonly<Record<string, string>>>({});
  private readonly awaitingReloadOfLawId = signal<string | undefined>(undefined);

  protected readonly isDraftBlank = computed(() => (this.editing()?.draft ?? '').trim().length === 0);

  private lawEntryOf(law: LawView) {
    const nowMs = this.now();
    return {
      ...law,
      text: showBidiControlsAsEscapes(law.text),
      excerpt: showBidiControlsAsEscapes(excerptOf(law.text)),
      provenance: PROVENANCE_LABELS[law.source],
      ageLabel: compactElapsedLabel(elapsedSecondsSince(law.updatedAt, nowMs)),
      withdrawnAgeLabel: compactElapsedLabel(elapsedSecondsSince(law.withdrawnAt ?? law.updatedAt, nowMs)),
    };
  }

  protected readonly activeLaws = computed(() => this.laws().filter((law) => law.status === 'active').map((law) => this.lawEntryOf(law)));
  protected readonly withdrawnLaws = computed(() => this.laws().filter((law) => law.status === 'withdrawn').map((law) => this.lawEntryOf(law)).reverse());

  constructor() {
    effect(() => this.draftField()?.nativeElement.focus());
    effect(() => this.adoptReloadedRevision());
  }

  /** After a conflict, the reloaded law is the one the draft is saved against: the human sees what it now reads. */
  private adoptReloadedRevision(): void {
    const awaitedLawId = this.awaitingReloadOfLawId();
    const edit = this.editing();
    const reloaded = this.laws().find((law) => law.id === awaitedLawId);
    const hasReloadedRevision = edit !== undefined && reloaded !== undefined && reloaded.revision !== edit.basisRevision;
    if (!hasReloadedRevision) return;
    this.awaitingReloadOfLawId.set(undefined);
    this.editing.set({ ...edit, basisRevision: reloaded.revision });
  }

  protected startEdit(law: LawView): void {
    this.cancelWithdrawal();
    this.forgetErrorOf(law.id);
    const original = this.laws().find((candidate) => candidate.id === law.id)!;
    this.editing.set({ lawId: original.id, draft: original.text, openedRevision: original.revision, basisRevision: original.revision });
  }

  protected updateDraft(draft: string): void {
    const edit = this.editing();
    if (edit) this.editing.set({ ...edit, draft });
  }

  protected cancelEdit(): void {
    this.editing.set(undefined);
    this.awaitingReloadOfLawId.set(undefined);
  }

  protected startWithdrawal(lawId: string): void {
    this.forgetErrorOf(lawId);
    this.withdrawingId.set(lawId);
  }

  protected cancelWithdrawal(): void {
    this.withdrawingId.set(undefined);
  }

  protected async saveEdit(law: LawView): Promise<void> {
    const edit = this.editing();
    if (!edit || this.isSaving()) return;
    await this.change({
      lawId: law.id,
      send: () => this.api.editLaw({ lawId: law.id, text: edit.draft.trim(), expectedRevision: edit.basisRevision }),
      onSuccess: () => this.editing.set(undefined),
      onConflict: () => this.awaitingReloadOfLawId.set(law.id),
    });
  }

  protected async confirmWithdrawal(law: LawView): Promise<void> {
    if (this.isSaving()) return;
    await this.change({
      lawId: law.id,
      send: () => this.api.withdrawLaw({ lawId: law.id, expectedRevision: law.revision }),
      onSuccess: () => this.withdrawingId.set(undefined),
      onConflict: () => this.withdrawingId.set(undefined),
    });
  }

  private async change({ lawId, send, onSuccess, onConflict }: { lawId: string; send: () => Promise<unknown>; onSuccess: () => void; onConflict: () => void }): Promise<void> {
    this.isSaving.set(true);
    this.forgetErrorOf(lawId);
    try {
      await send();
      onSuccess();
      this.reloadRequested.emit();
    } catch (error) {
      const isStale = error instanceof ApiError && error.code === LAW_REVISION_CONFLICT_CODE;
      this.errorsById.update((errors) => ({ ...errors, [lawId]: isStale ? LAW_CHANGED_COPY : copyFor(error, { action: 'generic' }).text }));
      if (isStale) {
        onConflict();
        this.reloadRequested.emit();
      }
    } finally {
      this.isSaving.set(false);
    }
  }

  private forgetErrorOf(lawId: string): void {
    this.errorsById.update((errors) => Object.fromEntries(Object.entries(errors).filter(([id]) => id !== lawId)));
  }
}
