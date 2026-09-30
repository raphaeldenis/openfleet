import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { countRenderCost, parseMarkdownBlocks, takeWithinRenderBudget } from './markdown-blocks';
import { displayTitleOf } from './note-title';
import type { NoteView } from '@openfleet/shared';

const NODES_PER_CHUNK = 2000;

@Component({
  selector: 'of-note-editor',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="header">
      <h2 #title class="title" tabindex="-1" data-testid="note-editor-title">{{ displayTitle() }}</h2>
      @if (note().docsRelativePath; as path) {
        <span class="path" data-testid="note-editor-path">{{ path }}</span>
      }
      <span class="spacer"></span>
      <button
        #historyButton
        type="button"
        class="history-toggle"
        data-testid="note-editor-history-toggle"
        [attr.aria-pressed]="historyOpen()"
        (click)="historyToggle.emit()"
      >History</button>
    </header>
    <ng-content />
    <div class="below-header">
      <div class="scroller">
        <article class="doc" data-testid="note-editor-body">
          @if (blocks().length === 0) {
            <p class="empty-body" data-testid="note-editor-empty-body">This note is empty.</p>
          }
          <ng-container [ngTemplateOutlet]="blockList" [ngTemplateOutletContext]="{ $implicit: blocks() }" />
          @if (hiddenItemCount() > 0) {
            <button type="button" class="of-btn of-btn--secondary show-rest" data-testid="note-editor-show-rest" (click)="showNextChunk()">
              Show the rest ({{ hiddenItemCount() }} more items)
            </button>
          }
        </article>
      </div>
      <ng-content select="of-note-history" />
    </div>

    <ng-template #blockList let-blocks>
      @for (block of blocks; track $index) {
        @switch (block.type) {
          @case ('heading') {
            @switch (block.level) {
              @case (1) { <h1 data-testid="note-editor-heading-1"><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: block.segments }" /></h1> }
              @case (2) { <h2 data-testid="note-editor-heading-2"><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: block.segments }" /></h2> }
              @default { <h3 data-testid="note-editor-heading-3"><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: block.segments }" /></h3> }
            }
          }
          @case ('paragraph') {
            <p data-testid="note-editor-paragraph"><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: block.segments }" /></p>
          }
          @case ('list') {
            <ul>
              @for (item of block.items; track $index) {
                <li data-testid="note-editor-list-item"><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: item }" /></li>
              }
            </ul>
          }
          @case ('ordered-list') {
            <ol data-testid="note-editor-ordered-list" [attr.start]="block.start">
              @for (item of block.items; track $index) {
                <li data-testid="note-editor-list-item"><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: item }" /></li>
              }
            </ol>
          }
          @case ('quote') {
            <blockquote data-testid="note-editor-quote">
              <ng-container [ngTemplateOutlet]="blockList" [ngTemplateOutletContext]="{ $implicit: block.blocks }" />
            </blockquote>
          }
          @case ('code') {
            <pre data-testid="note-editor-code-block">{{ block.text }}</pre>
          }
        }
      }
    </ng-template>
    <ng-template #inline let-segments>
      @for (segment of segments; track $index) {
        @if (segment.isCode) {
          <code data-testid="note-editor-inline-code">{{ segment.text }}</code>
        } @else if (segment.isBold) {
          <strong data-testid="note-editor-bold">{{ segment.text }}</strong>
        } @else { {{ segment.text }} }
      }
    </ng-template>
  `,
  styles: `
    :host { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0 }
    .header { flex: none; display: flex; align-items: center; gap: .75rem; padding: .625rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--panel) }
    .title { min-width: 0; margin: 0; font-size: inherit; font-weight: 600; outline: 0; overflow-wrap: anywhere }
    .show-rest { align-self: flex-start }
    .empty-body { color: var(--faint); font-style: italic }
    .path { font-family: var(--mono); font-size: .6875rem; color: var(--faint) }
    .spacer { flex: 1 }
    .history-toggle {
      height: 1.625rem; padding: 0 .625rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--panel);
      color: var(--fg); font: inherit; font-size: .75rem; cursor: pointer;
    }
    .history-toggle[aria-pressed='true'] { background: var(--active) }
    .history-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .below-header { flex: 1; min-height: 0; display: flex }
    .scroller { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 2rem 3rem; display: flex; justify-content: center }
    .doc { width: 100%; max-width: 42rem; display: flex; flex-direction: column; gap: .875rem; font-size: .9375rem; line-height: 1.65; text-wrap: pretty; overflow-wrap: anywhere }
    .doc h1, .doc h2, .doc h3, .doc p, .doc ul, .doc ol, .doc blockquote, .doc pre { margin: 0 }
    .doc h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -.01em }
    .doc h2 { margin-top: .5rem; font-size: 1.0625rem; font-weight: 600 }
    .doc h3 { margin-top: .25rem; font-size: .9375rem; font-weight: 600 }
    .doc :is(h1, h2, h3) strong { font-weight: inherit }
    .doc ul, .doc ol { padding-left: 1.25rem }
    .doc blockquote { display: flex; flex-direction: column; gap: .5rem; padding-left: .875rem; border-left: 3px solid var(--line); color: var(--mut) }
    .doc code { font-family: var(--mono); font-size: .8125rem; padding: 0 .25rem; border-radius: .25rem; background: var(--sunk) }
    .doc pre { padding: .625rem .75rem; border-radius: .375rem; background: var(--sunk); font-family: var(--mono); font-size: .8125rem; line-height: 1.5; overflow: auto }
  `,
})
export class NoteEditorComponent {
  readonly note = input.required<NoteView>();
  readonly historyOpen = input(false);
  readonly historyToggle = output<void>();

  private readonly title = viewChild.required<ElementRef<HTMLElement>>('title');
  private readonly historyButton = viewChild.required<ElementRef<HTMLElement>>('historyButton');
  private readonly renderBudget = signal(NODES_PER_CHUNK);
  private readonly allBlocks = computed(() => parseMarkdownBlocks(this.note().bodyMd));
  protected readonly blocks = computed(() => takeWithinRenderBudget(this.allBlocks(), this.renderBudget()));
  protected readonly hiddenItemCount = computed(() => countRenderCost(this.allBlocks()) - countRenderCost(this.blocks()));
  protected readonly displayTitle = computed(() => displayTitleOf(this.note().title));

  protected showNextChunk(): void {
    this.renderBudget.update((budget) => budget + NODES_PER_CHUNK);
  }

  focus(): void {
    this.title().nativeElement.focus();
  }

  focusHistoryToggle(): void {
    this.historyButton().nativeElement.focus();
  }
}
