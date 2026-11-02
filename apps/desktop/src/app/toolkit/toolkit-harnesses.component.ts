import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ToolSummary } from '@openfleet/shared';
import { KNOWN_HARNESSES } from './harnesses';
import { claudeCodeNameOf } from './tool-display';

const AVAILABILITY_LABELS = { supported: 'Supported', unknown: 'Unknown' } as const;

/** The harnesses the fleet may drive, and the name Claude Code gives each tool of the openfleet MCP server. */
@Component({
  selector: 'of-toolkit-harnesses',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="harnesses">
      <div class="cards">
        @for (harness of harnesses; track harness.id) {
          <div class="card" [attr.data-testid]="'toolkit-harness-' + harness.id">
            <div class="card-head">
              <span class="dot" [class.supported]="harness.availability === 'supported'" aria-hidden="true"></span>
              <span class="card-name">{{ harness.label }}</span>
            </div>
            <span class="card-state">{{ availabilityLabels[harness.availability] }}</span>
          </div>
        }
      </div>

      <div class="table-scroll" tabindex="0" role="region" aria-label="Tool names per harness">
        <table class="names">
          <thead>
            <tr><th scope="col">OpenFleet tool</th><th scope="col">Claude Code sees</th></tr>
          </thead>
          <tbody>
            @for (tool of tools(); track tool.name) {
              <tr [attr.data-testid]="'toolkit-claude-code-name-' + tool.name">
                <th scope="row">{{ tool.name }}</th>
                <td>{{ claudeCodeNameOf(tool.name) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; }
    .harnesses { display: flex; flex-direction: column; gap: 1rem; padding: 1rem; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: .75rem; }
    .card { display: flex; flex-direction: column; gap: .25rem; padding: .75rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .card-head { display: flex; align-items: center; gap: .375rem; }
    .card-name { font-weight: 600; }
    .card-state { font-size: .75rem; color: var(--mut); }
    .dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--state-closed); }
    .dot.supported { background: var(--state-idle); }
    .table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: .5rem; background: var(--panel); }
    .names { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: .71875rem; }
    th, td { padding: .4375rem .75rem; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
    th[scope='row'] { font-weight: 500; }
    td { color: var(--mut); }
    thead th { background: var(--sunk); color: var(--mut); font-family: inherit; font-size: .6875rem; font-weight: 600; }
  `,
})
export class ToolkitHarnessesComponent {
  readonly tools = input.required<readonly ToolSummary[]>();
  protected readonly harnesses = KNOWN_HARNESSES;
  protected readonly availabilityLabels = AVAILABILITY_LABELS;
  protected readonly claudeCodeNameOf = claudeCodeNameOf;
}
