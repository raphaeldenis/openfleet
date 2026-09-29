import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { parseMarkdownBlocks } from './markdown-blocks';
import type { NoteView } from './notes.types';

const MAX_BLOCKS_RENDERED_AT_FIRST = 2000;

export interface NoteMentioner { emoji: string; name: string }

@Component({
  selector: 'of-note-editor',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="header">
      <h2 #title class="title" tabindex="-1" data-testid="note-editor-title">{{ note().title }}</h2>
      @if (note().docsRelativePath; as path) {
        <span class="path" data-testid="note-editor-path">{{ path }}</span>
      }
      <span class="spacer"></span>
      <button
        type="button"
        class="history-toggle"
        data-testid="note-editor-history-toggle"
        [attr.aria-pressed]="historyOpen()"
        (click)="historyToggle.emit()"
      >History</button>
    </header>
    <div class="scroller">
      <article class="doc" data-testid="note-editor-body">
        @if (blocks().length === 0) {
          <p class="empty-body" data-testid="note-editor-empty-body">This note is empty.</p>
        }
        <ng-container [ngTemplateOutlet]="blockList" [ngTemplateOutletContext]="{ $implicit: blocks() }" />
        @if (hiddenBlockCount() > 0) {
          <button type="button" class="of-btn of-btn--secondary show-rest" data-testid="note-editor-show-rest" (click)="isShowingAllBlocks.set(true)">
            Show the remaining {{ hiddenBlockCount() }} blocks
          </button>
        }
        @if (mentionedBy().length > 0) {
          <footer class="mentioned-by" data-testid="note-editor-mentioned-by">
            <span>Mentioned by</span>
            <span class="mentioners">
              @for (mentioner of mentionedBy(); track mentioner.name; let last = $last) {
                {{ mentioner.emoji }} {{ mentioner.name }}{{ last ? '' : ' · ' }}
              }
            </span>
          </footer>
        }
      </article>
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
          @case ('code') {
            <pre data-testid="note-editor-code-block">{{ block.text }}</pre>
          }
          @case ('mention-note') {
            <section class="mention-note" [attr.data-testid]="'note-editor-mention-' + block.kind + '-' + block.id">
              <div class="mention-label">{{ block.title }}</div>
              <ng-container [ngTemplateOutlet]="blockList" [ngTemplateOutletContext]="{ $implicit: block.blocks }" />
            </section>
          }
          @case ('mention-line') {
            <div class="mention-line" [attr.data-testid]="'note-editor-mention-' + block.kind + '-' + block.id">
              &#64;{{ block.kind }}:{{ block.id }} · {{ block.text }}
            </div>
          }
        }
      }
    </ng-template>
    <ng-template #inline let-segments>
      @for (segment of segments; track $index) {
        @if (segment.isCode) { <code data-testid="note-editor-inline-code">{{ segment.text }}</code> } @else { {{ segment.text }} }
      }
    </ng-template>
  `,
  styles: `
    :host { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0 }
    .header { flex: none; display: flex; align-items: center; gap: .75rem; padding: .625rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--panel) }
    .title { margin: 0; font-size: inherit; font-weight: 600; outline: 0 }
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
    .scroller { flex: 1; min-height: 0; overflow: auto; padding: 2rem 3rem; display: flex; justify-content: center }
    .doc { width: 100%; max-width: 42rem; display: flex; flex-direction: column; gap: .875rem; font-size: .9375rem; line-height: 1.65; text-wrap: pretty }
    .doc h1, .doc h2, .doc h3, .doc p, .doc ul, .doc pre { margin: 0 }
    .doc h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -.01em }
    .doc h2 { margin-top: .5rem; font-size: 1.0625rem; font-weight: 600 }
    .doc h3 { margin-top: .25rem; font-size: .9375rem; font-weight: 600 }
    .doc ul { padding-left: 1.25rem }
    .doc code { font-family: var(--mono); font-size: .8125rem; padding: 0 .25rem; border-radius: .25rem; background: var(--sunk) }
    .doc pre { padding: .625rem .75rem; border-radius: .375rem; background: var(--sunk); font-family: var(--mono); font-size: .8125rem; line-height: 1.5; overflow: auto }
    .mention-note {
      display: flex; flex-direction: column; gap: .5rem; padding: .625rem .75rem; border-left: 3px solid var(--state-generating);
      border-radius: 0 .375rem .375rem 0; background: color-mix(in oklch, var(--state-generating) 8%, transparent);
    }
    .mention-label { font-size: .6875rem; color: var(--mut) }
    .mention-line { font-family: var(--mono); font-size: .75rem; color: var(--mut) }
    .mentioned-by { display: flex; gap: .5rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: .75rem; color: var(--mut) }
    .mentioners { color: var(--fg) }
  `,
})
export class NoteEditorComponent {
  readonly note = input.required<NoteView>();
  readonly expandedBody = input<string>();
  readonly mentionedBy = input<readonly NoteMentioner[]>([]);
  readonly historyOpen = input(false);
  readonly historyToggle = output<void>();

  private readonly title = viewChild.required<ElementRef<HTMLElement>>('title');
  protected readonly isShowingAllBlocks = signal(false);
  private readonly allBlocks = computed(() => parseMarkdownBlocks(this.expandedBody() ?? this.note().bodyMd));
  protected readonly blocks = computed(() => (this.isShowingAllBlocks() ? this.allBlocks() : this.allBlocks().slice(0, MAX_BLOCKS_RENDERED_AT_FIRST)));
  protected readonly hiddenBlockCount = computed(() => this.allBlocks().length - this.blocks().length);

  focus(): void {
    this.title().nativeElement.focus();
  }
}
