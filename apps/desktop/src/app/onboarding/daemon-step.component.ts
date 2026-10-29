import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, output, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../environments/environment';
import { DaemonStatusService } from '../core/daemon-status.service';
import { FleetApiService } from '../core/fleet-api.service';
import { SupportActions } from '../core/support-actions';
import { VersionsService } from '../core/versions.service';
import { STEP_PANEL_STYLES } from './step-panel.styles';

const HEALTH_POLL_INTERVAL_MS = 2000;
const DAEMON_READY_BEAT_MS = 1200;
const START_DAEMON_COMMAND = 'pnpm dev:core';
const STARTING_COPY = 'Starting the daemon…';
const SLOW_START_COPY = 'First launch can take up to a minute — macOS checks the app once.';
const FAILED_TITLE = 'The daemon could not start';
const FAILED_WITH_LAST_LINE_COPY = 'The daemon did not start — its last line:';
const FAILED_WITHOUT_LAST_LINE_COPY = 'The daemon did not start and printed nothing — check again in a moment.';
const UNKNOWN_TITLE = 'The daemon status is unknown';
const UNKNOWN_STATE_COPY = 'The daemon reports an unknown state — check the last line, then try again';
const STILL_NOT_RUNNING_COPY = 'Still not running — check the last line above, then try again.';
const MANUAL_CARD_TITLE_AFTER_FAILURE = 'Start it yourself';
const COPIED_ANNOUNCEMENT = 'Command copied';
const REVEAL_FAILURE_MESSAGE = 'Couldn’t open the logs folder';
const COPY_FAILURE_MESSAGE = 'Couldn’t copy — select the command and copy it by hand';

@Component({
  selector: 'of-daemon-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [DaemonStatusService],
  template: `
    <section class="step-panel" data-testid="onboarding-step-daemon">
      <header>
        <span class="kicker">Step 1 of 6 · Daemon</span>
        <h1>Start the OpenFleet daemon</h1>
        <p>The daemon runs your agents in the background so they keep working when this window is closed.</p>
      </header>
      @if (showsFailureCard()) {
        <div class="card card--failed" data-testid="daemon-failed">
          <div class="card-head"><span class="dot dot--error" aria-hidden="true"></span><h2 #failureHeading tabindex="-1">{{ failedTitle() }}</h2></div>
          <span class="hint-strong">{{ failedCopy() }}</span>
          @if (lastLine(); as lastLine) {
            <pre class="terminal last-line" tabindex="0" data-testid="daemon-last-line">{{ lastLine }}</pre>
          }
          @if (showsPathHint()) {
            <span class="hint" data-testid="daemon-path-hint">claude may not be on the daemon PATH — the login shell’s PATH could not be read. The built-in fallback PATH was used instead (Homebrew, /usr/local/bin, ~/.local/bin, /usr/bin, /bin).</span>
          }
          <div class="command-row"><button type="button" class="of-btn of-btn--primary" (click)="checkDaemonAgain()">Check again</button>@if (support.isAvailable) {<button type="button" class="of-btn of-btn--secondary" (click)="revealLog()">Reveal log</button>}</div>
          <span class="hint" role="status" data-testid="daemon-check-result">{{ checkResult() }}</span>
        </div>
      } @else if (showsProgress()) {
        <div class="card" data-testid="daemon-progress">
          <div class="card-head" role="status">
            @if (isStarting()) {
              <span class="spinner" aria-hidden="true"></span>
            } @else {
              <span class="ready-mark" aria-hidden="true">✓</span>
            }
            <span>{{ progressTitle() }}</span>
            @if (isSlow()) {
              <span class="hint" data-testid="daemon-slow-copy">{{ slowStartCopy }}</span>
            }
          </div>
          @if (isDaemonUp()) {
            <span class="hint">Continuing in a moment…</span>
          }
        </div>
      }
      @if (showsManualCard()) {
        <div class="card" data-testid="daemon-manual">
          <div class="card-head"><span class="dot" [class.dot--error]="!showsFailureCard()" [class.dot--amber]="showsFailureCard()" aria-hidden="true"></span><h2>{{ manualCardTitle() }}</h2></div>
          <span class="hint">Start the daemon: <code>{{ startDaemonCommand }}</code> in the OpenFleet folder. The first start creates <code>~/.openfleet/admin.token</code>; the app reads it by itself.</span>
          <div class="command-row">
            <div class="terminal">$ {{ startDaemonCommand }}</div>
            <button type="button" class="of-btn of-btn--secondary" (click)="copyCommand()">{{ hasCopiedCommand() ? 'Copied ✓' : 'Copy command' }}</button>
          </div>
          <span class="fine-print" [class.visually-hidden]="!copyFailureMessage()" role="status">{{ copyStatusMessage() }}</span>
          <span class="fine-print">Checking again every 2 s…</span>
        </div>
      }
    </section>
  `,
  styles: [
    STEP_PANEL_STYLES,
    `
    :host { display: contents }
    .card-head { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; font-weight: 500 }
    .card--failed { border-color: color-mix(in srgb, var(--state-error) 42%, var(--line)); background: color-mix(in srgb, var(--state-error) 10%, var(--panel)) }
    .dot { flex: none; width: .5rem; height: .5rem; border-radius: 50% }
    .dot--error { background: var(--state-error) }
    .dot--amber { background: var(--state-waiting-permission) }
    .hint { font-size: .75rem; color: var(--mut) }
    code { padding: 0 .25rem; border-radius: .25rem; background: var(--sunk); font-family: var(--mono); overflow-wrap: anywhere }
    .command-row { display: flex; align-items: center; gap: .5rem }
    .terminal { flex: 1; padding: .5rem .75rem; border-radius: .375rem; background: var(--term-bg); color: var(--term-fg); font-family: var(--mono); font-size: .75rem }
    .fine-print { font-size: .6875rem; color: var(--mut) }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
    h2 { margin: 0; font-size: .875rem; font-weight: 500 }
    h2:focus-visible { outline: 2px solid var(--accent); outline-offset: .125rem }
    .ready-mark { color: var(--fg); font-weight: 600 }
    .hint-strong { font-size: .75rem; color: var(--fg) }
    .last-line { margin: 0; max-height: 7.5rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text }
    .last-line:focus-visible { outline: 2px solid var(--accent); outline-offset: .125rem }
    .spinner { flex: none; width: .75rem; height: .75rem; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: of-daemon-spin 1s linear infinite }
    @keyframes of-daemon-spin { to { transform: rotate(360deg) } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none } }
  `,
  ],
})
export class DaemonStepComponent {
  private readonly api = inject(FleetApiService);
  private readonly versions = inject(VersionsService);
  private readonly daemon = inject(DaemonStatusService);
  protected readonly support = inject(SupportActions);

  /** Emits each time the daemon answers /health; the host decides where the user goes next. */
  readonly daemonAnswered = output<void>();

  protected readonly startDaemonCommand = START_DAEMON_COMMAND;
  protected readonly slowStartCopy = SLOW_START_COPY;
  protected readonly daemonAddress = environment.daemonAddress;

  private readonly failureHeading = viewChild<ElementRef<HTMLElement>>('failureHeading');
  private isDestroyed = false;

  protected readonly checkResult = signal('');
  protected readonly hasCopiedCommand = signal(false);
  protected readonly copyFailureMessage = signal('');
  protected readonly copyStatusMessage = computed(() => this.copyFailureMessage() || (this.hasCopiedCommand() ? COPIED_ANNOUNCEMENT : ''));

  private readonly daemonState = computed(() => this.daemon.status().state);
  protected readonly isStarting = computed(() => this.daemonState() === 'starting' || this.daemonState() === 'slow');
  protected readonly isSlow = computed(() => this.daemonState() === 'slow');
  protected readonly isDaemonUp = computed(() => this.daemonState() === 'ready' || this.daemonState() === 'reused');
  protected readonly isFailed = computed(() => this.daemonState() === 'failed');
  private readonly isUnknown = computed(() => this.daemonState() === 'unknown');
  protected readonly showsFailureCard = computed(() => this.isFailed() || this.isUnknown());
  protected readonly failedTitle = computed(() => (this.isUnknown() ? UNKNOWN_TITLE : FAILED_TITLE));
  protected readonly showsProgress = computed(() => this.daemon.isUnderTauri && (this.isStarting() || this.isDaemonUp()));
  protected readonly showsManualCard = computed(() => !this.daemon.isUnderTauri || this.showsFailureCard() || this.daemonState() === 'unavailable');
  protected readonly manualCardTitle = computed(() => (this.showsFailureCard() ? MANUAL_CARD_TITLE_AFTER_FAILURE : `No daemon on ${this.daemonAddress}`));
  private readonly observedStatus = computed(() => {
    const status = this.daemon.status();
    return status.state === 'unavailable' ? null : status;
  });
  protected readonly progressTitle = computed(() => {
    if (this.isStarting()) return STARTING_COPY;
    const daemonVersion = this.observedStatus()?.daemonVersion;
    return daemonVersion ? `Daemon ready · core ${daemonVersion}` : 'Daemon ready';
  });
  protected readonly lastLine = computed(() => this.observedStatus()?.lastLine);
  protected readonly failedCopy = computed(() => {
    if (this.isUnknown()) return UNKNOWN_STATE_COPY;
    return this.lastLine() ? FAILED_WITH_LAST_LINE_COPY : FAILED_WITHOUT_LAST_LINE_COPY;
  });
  // The PATH hint appears only when the failure itself names claude; a fallback PATH alone proves nothing.
  protected readonly showsPathHint = computed(() => {
    const status = this.observedStatus();
    const isFallbackPath = status?.pathSource === 'fallback';
    const failureNamesClaude = /claude/i.test(status?.lastLine ?? '');
    return isFallbackPath && failureNamesClaude;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.isDestroyed = true;
    });
    effect(() => this.failureHeading()?.nativeElement.focus());
    effect((onCleanup) => {
      if (!this.isDaemonUp()) return;
      const advanceTimer = setTimeout(() => void this.announceOnceDaemonAnswersHealth(), DAEMON_READY_BEAT_MS);
      onCleanup(() => clearTimeout(advanceTimer));
    });
    effect((onCleanup) => {
      let hasLeftDaemonStep = false;
      let nextCheckTimer: ReturnType<typeof setTimeout> | undefined;
      const checkDaemonThenScheduleNextCheck = async () => {
        const health = await this.api.health().catch(() => null);
        if (hasLeftDaemonStep) return;
        if (health) {
          this.versions.recordDaemonHealth(health);
          return this.daemonAnswered.emit();
        }
        nextCheckTimer = setTimeout(() => void checkDaemonThenScheduleNextCheck(), HEALTH_POLL_INTERVAL_MS);
      };
      onCleanup(() => {
        hasLeftDaemonStep = true;
        clearTimeout(nextCheckTimer);
      });
      untracked(() => void checkDaemonThenScheduleNextCheck());
    });
  }

  protected async checkDaemonAgain(): Promise<void> {
    this.checkResult.set('');
    const [health] = await Promise.all([this.api.health().catch(() => null), this.daemon.refresh()]);
    if (this.isDestroyed) return;
    if (health) {
      this.versions.recordDaemonHealth(health);
      return this.daemonAnswered.emit();
    }
    if (!this.isDaemonUp()) this.checkResult.set(STILL_NOT_RUNNING_COPY);
  }

  private async announceOnceDaemonAnswersHealth(): Promise<void> {
    const freshHealth = await this.api.health().catch(() => null);
    if (this.isDestroyed) return;
    if (!freshHealth) return void this.daemon.refresh();
    this.versions.recordDaemonHealth(freshHealth);
    this.daemonAnswered.emit();
  }

  protected async revealLog(): Promise<void> {
    this.checkResult.set('');
    await this.support.revealLogs().catch(() => this.checkResult.set(REVEAL_FAILURE_MESSAGE));
  }

  protected async copyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(START_DAEMON_COMMAND);
      this.hasCopiedCommand.set(true);
      this.copyFailureMessage.set('');
    } catch {
      this.hasCopiedCommand.set(false);
      this.copyFailureMessage.set(COPY_FAILURE_MESSAGE);
    }
  }
}
