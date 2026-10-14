import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, signal } from '@angular/core';
import type { PolicyMode } from '@openfleet/shared';
import { clockTimeOf } from '../core/clock-time';
import { FleetEventsService } from '../core/fleet-events.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { CommandPolicyState, type TriedPresence } from './command-policy.state';
import { SettingsRowComponent } from './settings-row.component';
import { SettingsSectionComponent } from './settings-section.component';
import { SETTINGS_VALUE_STYLES } from './settings-value-styles';

interface ModeOption { mode: PolicyMode; label: string; consequence: string }

const MODE_OPTIONS: ReadonlyArray<ModeOption> = [
  { mode: 'enforce', label: 'Enforce', consequence: 'Refuses what the rules of a role profile forbid, and tells the session an alternative it can follow.' },
  { mode: 'observe', label: 'Observe', consequence: 'Lets every command through and journals what the rules would have refused. The safe way to try a rule.' },
  { mode: 'off', label: 'Off', consequence: 'Switches the rules of the profiles off. Permission dialogs of unattended sessions are still refused: the switch below decides that.' },
];

const MODE_OFF_WITH_DIALOGS_UNREFUSED = 'Switches the rules of the profiles off. Permission dialogs of unattended sessions go to the approval flow too: nothing stops a child session on a prompt nobody sees.';

const ASK_BECOMES_DENY_CONSEQUENCES = {
  on: 'A child session that the CLI would ask about gets an immediate refusal with an alternative, so it never waits on a prompt nobody sees. A manager keeps its approval cards.',
  off: 'Permission dialogs of child sessions go back to the approval flow. A child may then sit on a prompt nobody sees until the safety net alerts its manager after 30 seconds. Turn this off to roll back, not as a setting to keep.',
};

const TRIED_PRESENCES: ReadonlyArray<{ value: TriedPresence; label: string }> = [
  { value: 'unattended', label: 'Unattended child session' },
  { value: 'attended', label: 'Attended session' },
];

const SHORT_SESSION_ID_LENGTH = 8;
const DEGRADED_ISSUE_CODE = 'hook_fail_open';

@Component({
  selector: 'of-command-policy-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, SettingsSectionComponent, SettingsRowComponent],
  providers: [CommandPolicyState],
  template: `
    <of-settings-section heading="Command policy" testId="settings-command-policy">
      @if (state.hasFailedToLoad()) {
        <p class="error" role="alert" data-testid="policy-error"><of-error-line>Couldn’t load the command policy from the daemon.</of-error-line></p>
      } @else if (state.view(); as view) {
        <div class="rows">
          <of-settings-row name="Mode" detail="Applies to the next command of every session, no restart">
            <div class="modes" role="radiogroup" aria-label="Command policy mode" aria-describedby="policy-mode-consequence">
              @for (option of modeOptions; track option.mode) {
                <label class="mode" [attr.data-selected]="option.mode === view.mode ? '1' : null">
                  <input type="radio" name="command-policy-mode" [value]="option.mode" [checked]="option.mode === view.mode" [attr.data-testid]="'policy-mode-' + option.mode" (change)="chooseMode(option.mode)" />
                  <span>{{ option.label }}</span>
                </label>
              }
            </div>
          </of-settings-row>
          <of-settings-row name="Refuse permission dialogs nobody can answer" detail="Child sessions only · independent of the mode">
            <button
              type="button" role="switch" class="value switch" data-testid="policy-ask-becomes-deny"
              aria-label="Refuse permission dialogs nobody can answer" [attr.data-warning]="view.unattended.askBecomesDeny ? null : '1'"
              [attr.aria-checked]="view.unattended.askBecomesDeny" aria-describedby="policy-ask-consequence"
              (click)="state.setAskBecomesDeny(!view.unattended.askBecomesDeny)"
            >{{ view.unattended.askBecomesDeny ? 'On' : 'Off' }}</button>
          </of-settings-row>
        </div>
        <p class="hint" id="policy-mode-consequence" data-testid="policy-mode-consequence">{{ modeConsequenceOf({ mode: view.mode, askBecomesDeny: view.unattended.askBecomesDeny }) }}</p>
        <p class="hint" id="policy-ask-consequence" data-testid="policy-ask-consequence" [attr.data-warning]="view.unattended.askBecomesDeny ? null : '1'">{{ view.unattended.askBecomesDeny ? askConsequences.on : askConsequences.off }}</p>
        <p class="hint status" role="status" data-testid="policy-save-status">{{ state.saveStatusMessage() }}</p>
        @if (failedSave(); as failure) {
          <p class="error" role="alert" data-testid="policy-save-error"><of-error-line>{{ failure }}</of-error-line></p>
        }

        <p class="degradation" [attr.data-degraded]="degradedCount() > 0 ? '1' : null" role="status" data-testid="policy-degraded">
          @if (degradedCount() > 0) {
            Degraded: the policy engine failed open {{ degradedCount() }} {{ degradedCount() === 1 ? 'time' : 'times' }} — some commands went through unchecked.
          } @else {
            Policy engine healthy: no evaluation failed open.
          }
        </p>

        @if (view.issues.length > 0) {
          <p class="error" role="status" data-testid="policy-file-issues"><of-error-line>Parts of command-policy.json are ignored: {{ view.issues.join(' · ') }}. Saving here rewrites the file without them and keeps a copy.</of-error-line></p>
        }

        <h2 class="of-section-title">Rules</h2>
        <div class="rows table-card">
          <table data-testid="policy-rules">
            <caption class="sr-only">Command policy rules</caption>
            <thead>
              <tr><th scope="col">Rule</th><th scope="col">Profiles</th><th scope="col">Decision</th><th scope="col">Alternative</th><th scope="col">State</th></tr>
            </thead>
            <tbody>
              @for (rule of view.rules; track rule.id) {
                <tr [attr.data-testid]="'policy-rule-' + rule.id" [attr.data-enabled]="rule.enabled ? '1' : '0'">
                  <th scope="row" class="rule-name"><div class="rule-name-lines"><span class="mono">{{ rule.id }}</span><span class="reason">{{ rule.reason }}</span></div></th>
                  <td class="mono">{{ rule.profiles.length > 0 ? rule.profiles.join(', ') : '—' }}</td>
                  <td><span class="of-badge decision" [attr.data-decision]="rule.decision">{{ rule.decision }}</span></td>
                  <td class="alternative">{{ rule.alternative ?? '—' }}</td>
                  <td class="state">
                    @if (rule.origin === 'delivered') {
                      <button
                        type="button" class="of-btn of-btn--compact of-btn--secondary" [attr.data-testid]="'policy-rule-toggle-' + rule.id"
                        [attr.aria-label]="(rule.enabled ? 'Disable rule ' : 'Enable rule ') + rule.id"
                        (click)="state.setRuleEnabled(rule.id, !rule.enabled)"
                      >{{ rule.enabled ? 'Disable' : 'Enable' }}</button>
                      <span class="state-text">{{ rule.enabled ? 'Enabled' : 'Disabled' }}</span>
                    } @else {
                      <span class="state-text">Custom · edit command-policy.json, then restart the daemon to apply</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <h2 class="of-section-title">Try a command</h2>
        <form class="try" (submit)="tryCommand($event)" data-testid="policy-try">
          <div class="of-field">
            <label class="of-label" for="policy-try-command">Command to try</label>
            <input #commandInput id="policy-try-command" class="of-input mono" autocomplete="off" spellcheck="false" aria-describedby="policy-try-hint" data-testid="policy-try-command" (input)="tryCommandEdited(commandInput.value)" />
          </div>
          <div class="try-options">
            <div class="of-field">
              <label class="of-label" for="policy-try-role">Role (optional)</label>
              <input #roleInput id="policy-try-role" class="of-input" autocomplete="off" placeholder="DEV" data-testid="policy-try-role" (input)="triedRole.set(roleInput.value)" />
            </div>
            <div class="of-field">
              <label class="of-label" for="policy-try-presence">Session</label>
              <select #presenceInput id="policy-try-presence" class="of-input" data-testid="policy-try-presence" (change)="triedPresence.set(presenceInput.value === 'attended' ? 'attended' : 'unattended')">
                @for (presence of triedPresences; track presence.value) {
                  <option [value]="presence.value">{{ presence.label }}</option>
                }
              </select>
            </div>
            <button type="submit" class="of-btn of-btn--secondary try-button" data-testid="policy-try-button" [disabled]="!hasTriedCommand()" [attr.aria-disabled]="state.isTrying()">Try it</button>
          </div>
          <p class="hint" id="policy-try-hint">The command is judged, never run, and nothing is journaled.</p>
        </form>
        <div class="try-result" role="status" aria-live="polite" data-testid="policy-try-result" [attr.data-refusal]="state.tryOutcome()?.isRefusal ? '1' : null">
          @if (state.tryOutcome(); as outcome) {
            <strong>{{ outcome.headline }}</strong>
            @for (detail of outcome.details; track $index) {
              <span class="detail">{{ detail }}</span>
            }
          }
          @if (state.tryFailure(); as failure) {
            <of-error-line>{{ failure }}</of-error-line>
          }
        </div>

        <div class="section-head">
          <h2 class="of-section-title" tabindex="-1" data-testid="policy-denials-title">Recent refusals</h2>
          <button type="button" class="of-btn of-btn--compact of-btn--secondary" data-testid="policy-denials-refresh" (click)="state.loadDenials()">Refresh</button>
        </div>
        @if (state.hasFailedToLoadDenials()) {
          <p class="error" role="alert" data-testid="policy-denials-error"><of-error-line>Couldn’t load the refusals from the daemon.</of-error-line></p>
        }
        @if (state.denials().length === 0) {
          <p class="hint" data-testid="policy-denials-empty">No refusal recorded yet.</p>
        } @else {
          <ul class="denials" aria-label="Recent refusals" data-testid="policy-denials">
            @for (denial of state.denials(); track denial.id) {
              <li data-testid="policy-denial">
                <div class="denial-head">
                  <span class="of-badge outcome" [attr.data-outcome]="denial.outcome">{{ denial.outcome === 'denied' ? 'Refused' : 'Observed' }}</span>
                  <span class="mono">{{ denial.ruleId }}</span>
                  <span class="meta">{{ clockTimeOf(denial.createdAt) }} · {{ denial.actor }} · session {{ shortIdOf(denial.sessionId) }}</span>
                </div>
                <code class="excerpt">{{ denial.commandExcerpt }}</code>
                @if (denial.alternative) {
                  <span class="detail">Alternative: {{ denial.alternative }}</span>
                }
              </li>
            }
          </ul>
          @if (state.nextDenialsCursor()) {
            <button type="button" class="of-btn of-btn--secondary more" data-testid="policy-denials-more" (click)="loadMoreDenials()">Load more</button>
          }
        }
      } @else {
        <div class="loading" data-testid="policy-loading" role="status" aria-busy="true" aria-label="Loading the command policy">
          @for (placeholder of loadingPlaceholders; track placeholder) {
            <div class="skeleton"></div>
          }
        </div>
      }
    </of-settings-section>
  `,
  styles: `
    ${SETTINGS_VALUE_STYLES}
    :host { display: block; }
    .modes { display: flex; gap: .25rem; }
    .mode { display: inline-flex; align-items: center; gap: .375rem; height: 1.75rem; padding: 0 .625rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); font-size: .75rem; cursor: pointer; }
    .mode[data-selected='1'] { border-color: var(--accent); background: var(--accent-bg); }
    .mode:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: .125rem; }
    .mode input { margin: 0; accent-color: var(--accent); }
    .mode input:focus-visible { outline: none; }
    .switch[aria-checked='true'] { border-color: var(--accent); background: var(--accent-bg); }
    .switch[data-warning='1'] { border-color: var(--state-waiting-permission); color: var(--state-waiting-permission); }
    #policy-ask-consequence[data-warning='1'] { padding-left: .5rem; border-left: 2px solid var(--state-waiting-permission); }
    .status { min-height: 1lh; }
    .degradation { margin: 0; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--panel); font-size: .75rem; color: var(--mut); }
    .degradation[data-degraded='1'] { border-color: var(--state-waiting-permission); color: var(--fg); }
    h2 { margin: .5rem 0 0; }
    .table-card { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: .75rem; }
    th, td { padding: .5rem .625rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    thead th { font-weight: 600; color: var(--mut); }
    tbody tr:last-child > * { border-bottom: 0; }
    tbody tr[data-enabled='0'] { color: var(--mut); }
    .rule-name { font-weight: 400; }
    .rule-name-lines { display: flex; flex-direction: column; gap: .125rem; }
    .reason { color: var(--mut); overflow-wrap: anywhere; }
    .alternative { color: var(--mut); overflow-wrap: anywhere; min-width: 10rem; }
    .decision[data-decision='deny'] { background: color-mix(in oklch, var(--state-error) 14%, transparent); color: var(--fg); }
    .decision[data-decision='ask'] { background: color-mix(in oklch, var(--state-waiting-permission) 14%, transparent); color: var(--fg); }
    .decision[data-decision='allow'] { background: color-mix(in oklch, var(--state-idle) 14%, transparent); color: var(--fg); }
    .state { white-space: nowrap; }
    .state-text { margin-left: .375rem; color: var(--mut); }
    .try { display: flex; flex-direction: column; gap: .5rem; }
    .try-options { display: flex; align-items: flex-end; gap: .75rem; flex-wrap: wrap; }
    .try-button { align-self: flex-end; }
    .try-result { display: flex; flex-direction: column; gap: .125rem; min-height: 1.5rem; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--panel); }
    .try-result:empty { display: none; }
    .try-result[data-refusal='1'] { border-color: var(--state-error); }
    .detail { font-size: .75rem; color: var(--mut); overflow-wrap: anywhere; }
    .section-head { display: flex; align-items: center; justify-content: space-between; }
    .denials { margin: 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .denials li { display: flex; flex-direction: column; gap: .25rem; padding: .625rem .75rem; border-bottom: 1px solid var(--line); }
    .denials li:last-child { border-bottom: 0; }
    .denial-head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; font-size: .75rem; }
    .outcome[data-outcome='denied'] { background: color-mix(in oklch, var(--state-error) 14%, transparent); }
    .outcome[data-outcome='observed'] { background: var(--sunk); }
    .meta { color: var(--mut); }
    .excerpt { font-family: var(--mono); font-size: .75rem; overflow-wrap: anywhere; white-space: pre-wrap; }
    .more { align-self: flex-start; }
    .loading { display: flex; flex-direction: column; gap: .5rem; }
    .skeleton { height: 3rem; border-radius: .625rem; background: var(--sunk); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `,
})
export class CommandPolicySettingsComponent {
  protected readonly state = inject(CommandPolicyState);
  private readonly events = inject(FleetEventsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly modeOptions = MODE_OPTIONS;
  protected readonly askConsequences = ASK_BECOMES_DENY_CONSEQUENCES;
  protected readonly triedPresences = TRIED_PRESENCES;
  protected readonly loadingPlaceholders = [0, 1, 2];
  protected readonly clockTimeOf = clockTimeOf;

  protected readonly triedCommand = signal('');
  protected readonly triedRole = signal('');
  protected readonly triedPresence = signal<TriedPresence>('unattended');
  protected readonly hasTriedCommand = computed(() => this.triedCommand().trim() !== '');
  protected readonly canTry = computed(() => this.hasTriedCommand() && !this.state.isTrying());
  protected readonly degradedCount = computed(() => this.events.daemonIssues().find((issue) => issue.code === DEGRADED_ISSUE_CODE)?.count ?? 0);
  protected readonly failedSave = computed(() => {
    const save = this.state.saveState();
    return save.kind === 'failed' ? save.cause : undefined;
  });

  constructor() {
    void this.state.load();
  }

  protected modeConsequenceOf({ mode, askBecomesDeny }: { mode: PolicyMode; askBecomesDeny: boolean }): string {
    if (mode === 'off' && !askBecomesDeny) return MODE_OFF_WITH_DIALOGS_UNREFUSED;
    return MODE_OPTIONS.find((option) => option.mode === mode)?.consequence ?? '';
  }

  protected async chooseMode(mode: PolicyMode): Promise<void> {
    await this.state.setMode(mode);
    this.showSavedModeInRadios();
  }

  protected tryCommandEdited(command: string): void {
    this.triedCommand.set(command);
    this.state.clearTryResult();
  }

  protected async loadMoreDenials(): Promise<void> {
    await this.state.loadMoreDenials();
    const isLastPage = this.state.nextDenialsCursor() === undefined;
    if (isLastPage) this.host.nativeElement.querySelector<HTMLElement>('[data-testid="policy-denials-title"]')?.focus();
  }

  protected tryCommand(event: Event): void {
    event.preventDefault();
    if (!this.canTry()) return;
    void this.state.tryCommand({ command: this.triedCommand().trim(), role: this.triedRole(), presence: this.triedPresence() });
  }

  protected shortIdOf(sessionId: string): string {
    return sessionId.slice(0, SHORT_SESSION_ID_LENGTH);
  }

  /** A refused save leaves the previous mode in force: the radios, and the focus a keyboard user had on one of them, go back to it. */
  private showSavedModeInRadios(): void {
    if (this.state.isSaving()) return;
    const savedMode = this.state.view()?.mode;
    const radios = [...this.host.nativeElement.querySelectorAll<HTMLInputElement>('input[name="command-policy-mode"]')];
    radios.forEach((radio) => (radio.checked = radio.value === savedMode));
    const focusedRadio = radios.find((radio) => radio === document.activeElement);
    if (focusedRadio && focusedRadio.value !== savedMode) radios.find((radio) => radio.checked)?.focus();
  }
}
