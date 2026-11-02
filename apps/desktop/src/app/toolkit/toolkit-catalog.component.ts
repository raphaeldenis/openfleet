import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { ToolSummary } from '@openfleet/shared';
import { categoryLabelOf, claudeCodeNameOf, domainLabelOf } from './tool-display';

interface DomainGroup { domain: string; tools: readonly ToolSummary[] }

const byName = (left: ToolSummary, right: ToolSummary): number => left.name.localeCompare(right.name);

function groupByDomain(tools: readonly ToolSummary[]): DomainGroup[] {
  const toolsByDomain = new Map<string, ToolSummary[]>();
  for (const tool of [...tools].sort(byName)) toolsByDomain.set(tool.domain, [...(toolsByDomain.get(tool.domain) ?? []), tool]);
  return [...toolsByDomain].map(([domain, domainTools]) => ({ domain, tools: domainTools })).sort((left, right) => left.domain.localeCompare(right.domain));
}

/** The MCP tools by domain, with a search and, for the tool picked, its domain, its category and the name Claude Code gives it. */
@Component({
  selector: 'of-toolkit-catalog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="catalog">
      <aside class="list">
        <input class="search" type="search" placeholder="Search tools" aria-label="Search tools" [value]="search()" (input)="search.set($any($event.target).value)" />
        @for (group of groups(); track group.domain) {
          <div class="group" [attr.data-testid]="'toolkit-domain-' + group.domain">
            <div class="group-head"><span>{{ domainLabelOf(group.domain) }}</span><span>{{ group.tools.length }}</span></div>
            @for (tool of group.tools; track tool.name) {
              <button type="button" class="tool" [attr.aria-current]="tool.name === shownTool()?.name ? 'true' : null" (click)="picked.set(tool.name)">{{ tool.name }}</button>
            }
          </div>
        } @empty {
          <p class="no-match" data-testid="toolkit-no-match">No tool matches</p>
        }
      </aside>

      @if (shownTool(); as tool) {
        <section class="details" data-testid="toolkit-tool-details" aria-live="polite">
          <div class="title">
            <span class="name">{{ tool.name }}</span>
            <span class="domain">{{ domainLabelOf(tool.domain) }}</span>
          </div>
          <dl class="facts">
            <dt>Category</dt>
            <dd><span class="category" [attr.data-category]="tool.category">{{ categoryLabelOf(tool.category) }}</span></dd>
            <dt>Claude Code sees</dt>
            <dd class="mono">{{ claudeCodeNameOf(tool.name) }}</dd>
          </dl>
          <button type="button" class="of-btn of-btn--compact calls" (click)="activityRequested.emit(tool.name)">View calls →</button>
        </section>
      }
    </div>
  `,
  styles: `
    :host { display: block; flex: 1; min-height: 0; }
    .catalog { height: 100%; min-height: 0; display: flex; }
    .list { width: 17rem; flex: none; overflow: auto; border-right: 1px solid var(--line); background: var(--panel); padding: .5rem; }
    .search { box-sizing: border-box; width: 100%; height: 1.75rem; margin-bottom: .375rem; padding: 0 .5rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); color: var(--fg); font-size: .75rem; }
    .group-head { display: flex; justify-content: space-between; padding: .5rem .5rem .1875rem; font-size: .6875rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--mut); }
    .tool { display: block; width: 100%; height: 1.625rem; padding: 0 .5rem; border: 0; border-radius: .375rem; background: transparent; color: var(--fg); font-family: var(--mono); font-size: .71875rem; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .tool[aria-current='true'] { background: var(--active); }
    .tool:focus-visible, .search:focus-visible { outline: .125rem solid var(--accent); outline-offset: -.125rem; }
    .no-match { margin: .5rem; font-size: .75rem; color: var(--mut); }
    .details { flex: 1; min-width: 0; overflow: auto; padding: 1.25rem 1.5rem; display: flex; flex-direction: column; gap: 1rem; }
    .title { display: flex; align-items: center; gap: .625rem; }
    .name { font-family: var(--mono); font-size: 1.0625rem; font-weight: 600; overflow-wrap: anywhere; }
    .domain { font-size: .6875rem; padding: 0 .375rem; border: 1px solid var(--line-2); border-radius: .25rem; color: var(--mut); }
    .facts { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1rem; font-size: .75rem; }
    dt { color: var(--mut); }
    dd { margin: 0; min-width: 0; }
    .mono { font-family: var(--mono); overflow-wrap: anywhere; }
    .calls { align-self: flex-start; }
    .category { display: inline-block; padding: 0 .375rem; border: 1px solid var(--line-2); border-radius: .25rem; }
    .category[data-category='destructive'] { color: var(--state-error); border-color: var(--state-error); }
    .category[data-category='execution_external'] { color: var(--state-waiting-permission); border-color: var(--state-waiting-permission); }
    @media (max-width: 56rem) {
      .catalog { flex-direction: column; }
      .list { width: auto; max-height: 40%; border-right: 0; border-bottom: 1px solid var(--line); }
    }
  `,
})
export class ToolkitCatalogComponent {
  readonly tools = input.required<readonly ToolSummary[]>();
  readonly activityRequested = output<string>();
  protected readonly search = signal('');
  protected readonly picked = signal<string | undefined>(undefined);
  protected readonly domainLabelOf = domainLabelOf;
  protected readonly categoryLabelOf = categoryLabelOf;
  protected readonly claudeCodeNameOf = claudeCodeNameOf;

  protected readonly groups = computed(() => {
    const wanted = this.search().trim().toLowerCase();
    const matching = this.tools().filter((tool) => tool.name.toLowerCase().includes(wanted));
    return groupByDomain(matching);
  });

  protected readonly shownTool = computed(() => {
    const listed = this.groups().flatMap((group) => group.tools);
    return listed.find((tool) => tool.name === this.picked()) ?? listed[0];
  });
}
