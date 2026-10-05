import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { countRenderCost, parseMarkdownBlocks, takeWithinRenderBudget } from './markdown-blocks';

const NODES_PER_CHUNK = 2000;

/** Renders markdown as read-only text: headings, paragraphs, lists, quotes, code. A long document shows in chunks. */
@Component({
  selector: 'of-markdown-view',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="doc">
      <ng-container [ngTemplateOutlet]="blockList" [ngTemplateOutletContext]="{ $implicit: blocks() }" />
      @if (hiddenItemCount() > 0) {
        <button type="button" class="of-btn of-btn--secondary show-rest" (click)="showNextChunk()">Show the rest ({{ hiddenItemCount() }} more items)</button>
      }
    </div>

    <ng-template #blockList let-blocks>
      @for (block of blocks; track $index) {
        @switch (block.type) {
          @case ('heading') {
            @switch (block.level) {
              @case (1) { <h3><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: block.segments }" /></h3> }
              @case (2) { <h4><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: block.segments }" /></h4> }
              @default { <h5><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: block.segments }" /></h5> }
            }
          }
          @case ('paragraph') {
            <p><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: block.segments }" /></p>
          }
          @case ('list') {
            <ul>
              @for (item of block.items; track $index) {
                <li><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: item }" /></li>
              }
            </ul>
          }
          @case ('ordered-list') {
            <ol [attr.start]="block.start">
              @for (item of block.items; track $index) {
                <li><ng-container [ngTemplateOutlet]="inline" [ngTemplateOutletContext]="{ $implicit: item }" /></li>
              }
            </ol>
          }
          @case ('quote') {
            <blockquote><ng-container [ngTemplateOutlet]="blockList" [ngTemplateOutletContext]="{ $implicit: block.blocks }" /></blockquote>
          }
          @case ('code') {
            <pre>{{ block.text }}</pre>
          }
        }
      }
    </ng-template>
    <ng-template #inline let-segments>
      @for (segment of segments; track $index) {
        @if (segment.isCode) {
          <code>{{ segment.text }}</code>
        } @else if (segment.isBold) {
          <strong>{{ segment.text }}</strong>
        } @else { {{ segment.text }} }
      }
    </ng-template>
  `,
  styles: `
    :host { display: block }
    .doc { display: flex; flex-direction: column; gap: .625rem; font-size: .8125rem; line-height: 1.6; overflow-wrap: anywhere }
    .doc :is(h3, h4, h5, p, ul, ol, blockquote, pre) { margin: 0 }
    .doc h3 { font-size: .9375rem; font-weight: 600 }
    .doc h4, .doc h5 { font-size: .8125rem; font-weight: 600 }
    .doc :is(h3, h4, h5) strong { font-weight: inherit }
    .doc ul, .doc ol { padding-left: 1.25rem }
    .doc blockquote { display: flex; flex-direction: column; gap: .5rem; padding-left: .875rem; border-left: 3px solid var(--line); color: var(--mut) }
    .doc code { font-family: var(--mono); font-size: .75rem; padding: 0 .25rem; border-radius: .25rem; background: var(--sunk) }
    .doc pre { padding: .5rem .625rem; border-radius: .375rem; background: var(--sunk); font-family: var(--mono); font-size: .75rem; line-height: 1.5; overflow: auto }
    .show-rest { align-self: flex-start }
  `,
})
export class MarkdownViewComponent {
  readonly markdown = input.required<string>();
  readonly nodesPerChunk = input(NODES_PER_CHUNK);

  private readonly chunksShown = signal(1);
  private readonly allBlocks = computed(() => parseMarkdownBlocks(this.markdown()));
  protected readonly blocks = computed(() => takeWithinRenderBudget(this.allBlocks(), this.chunksShown() * this.nodesPerChunk()));
  protected readonly hiddenItemCount = computed(() => countRenderCost(this.allBlocks()) - countRenderCost(this.blocks()));

  protected showNextChunk(): void {
    this.chunksShown.update((chunks) => chunks + 1);
  }
}
