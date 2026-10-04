import { Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { environment } from '../../environments/environment';
import { DaemonStatusService } from '../core/daemon-status.service';
import { FleetApiService } from '../core/fleet-api.service';
import { SupportActions } from '../core/support-actions';
import { VersionsService } from '../core/versions.service';
import { EmbeddedSessionSeed, NewSessionFormComponent } from '../sessions/new-session-form.component';

type StepId = 'daemon' | 'providers' | 'project' | 'playbooks' | 'team' | 'first-session';

const HEALTH_POLL_INTERVAL_MS = 2000;
const APP_HOME_URL = '/';
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
const DEFERRED_STEP_LABEL = 'Available in a later phase';
const FIRST_SESSION_NAME = 'First session';
const FIRST_SESSION_SEEDED_PROMPT = 'Read the README and give me a short tour of this project. Do not modify any files.';

const STEPS: ReadonlyArray<{ id: StepId; name: string; isBuilt: boolean }> = [
  { id: 'daemon', name: 'Daemon', isBuilt: true },
  { id: 'providers', name: 'Providers', isBuilt: false },
  { id: 'project', name: 'Project', isBuilt: true },
  { id: 'playbooks', name: 'Playbooks', isBuilt: false },
  { id: 'team', name: 'Team', isBuilt: false },
  { id: 'first-session', name: 'First session', isBuilt: true },
];

function requestedUrlFrom(navigationState: unknown): string {
  const requestedUrl = (navigationState as { returnUrl?: unknown } | null)?.returnUrl;
  const isAppUrl = typeof requestedUrl === 'string' && requestedUrl.startsWith('/') && !requestedUrl.startsWith('/onboarding');
  return isAppUrl ? requestedUrl : APP_HOME_URL;
}

@Component({
  selector: 'of-onboarding',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, NewSessionFormComponent],
  providers: [DaemonStatusService],
  viewProviders: [EmbeddedSessionSeed],
  template: `
    <div class="page" data-testid="onboarding">
      <div class="topbar"><a [routerLink]="returnUrlTree" class="skip">Skip to app →</a></div>

      <ol class="stepper" aria-label="Setup steps">
        @for (step of steps(); track step.id) {
          <li class="step" [attr.aria-current]="step.isCurrent ? 'step' : null" [attr.data-state]="step.state">
            <span class="bar"></span>
            <span class="step-name"><span class="mono" aria-hidden="true">{{ step.mark }}</span>{{ step.name }}@if (step.state === 'done') {<span class="visually-hidden"> done</span>}</span>
            @if (!step.isBuilt) {
              <span class="step-later">{{ deferredStepLabel }}</span>
            }
          </li>
        }
      </ol>

      <div class="content">
        @switch (currentStepId()) {
          @case ('daemon') {
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
          }
          @case ('project') {
            <section class="step-panel" data-testid="onboarding-step-project">
              <header>
                <span class="kicker">Step 3 of 6 · Project</span>
                <h1>Define the project</h1>
                <p>Sessions run in your repository. Type its path — folder discovery is not available yet.</p>
              </header>
              <form class="project-form" (ngSubmit)="continueToFirstSession()">
                <div class="card">
                  <label class="of-field">
                    <span class="of-label">Repository path</span>
                    <input class="of-input" name="repositoryPath" [ngModel]="repositoryPath()" (ngModelChange)="repositoryPath.set($event)" placeholder="/path/to/repository" />
                  </label>
                </div>
                <div class="footer">
                  <span class="footer-note">Next: start your first session</span>
                  <button type="submit" class="of-btn of-btn--primary" [disabled]="!hasRepositoryPath()">Continue</button>
                </div>
              </form>
            </section>
          }
          @case ('first-session') {
            <section class="step-panel" data-testid="onboarding-step-first-session">
              <header>
                <span class="kicker">Step 6 of 6 · First session</span>
                <h1>Start your first session</h1>
                <p>Land in a terminal in under a minute.</p>
              </header>
              <p class="seeded-prompt">The session starts by sending this prompt: <q>{{ seededPrompt }}</q></p>
              <of-new-session-form>
                <button type="button" class="of-btn of-btn--secondary back" [attr.aria-disabled]="isCreatingFirstSession() || null" (click)="backToProject()">Back</button>
              </of-new-session-form>
            </section>
          }
        }
      </div>
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0 }
    .page { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg); color: var(--fg) }
    .topbar { display: flex; flex: none; justify-content: flex-end; align-items: center; height: 2.75rem; padding: 0 .875rem }
    .skip { color: var(--mut); font-size: .75rem; text-decoration: none }
    .skip:focus-visible { outline: 2px solid var(--accent); outline-offset: .125rem }
    .stepper { display: flex; flex: none; align-items: flex-start; gap: .25rem; width: 56rem; max-width: calc(100% - 4rem); margin: 0 auto; padding: 0 0 .5rem; box-sizing: border-box; list-style: none }
    .step { display: flex; flex: 1 1 0; flex-direction: column; gap: .375rem; min-width: 0; font-size: .6875rem; color: var(--mut) }
    .step .bar { height: .25rem; border-radius: .125rem; background: var(--line) }
    .step-name { display: flex; align-items: center; gap: .25rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
    .step-later { font-size: .6875rem; color: var(--mut) }
    .step[data-state='done'] { color: var(--mut) }
    .step[data-state='done'] .bar { background: var(--state-idle) }
    .step[data-state='current'] { color: var(--fg) }
    .step[data-state='current'] .bar { background: var(--accent) }
    .content { display: flex; flex: 1; align-items: flex-start; justify-content: center; min-height: 0; overflow: auto; padding: 1rem 2rem 0; scroll-padding-bottom: 3.5rem }
    .step-panel { display: flex; flex-direction: column; gap: 1rem; width: 56rem; max-width: 100%; padding-bottom: 2rem }
    header { display: flex; flex-direction: column; gap: .25rem }
    .kicker { font-size: .75rem; color: var(--mut) }
    h1 { margin: 0; font-size: 1.375rem; font-weight: 600; letter-spacing: -.015em }
    header p { margin: 0; color: var(--mut); font-size: .875rem }
    .card { display: flex; flex-direction: column; gap: .625rem; padding: 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel) }
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
    .of-field { display: flex; flex-direction: column; gap: .25rem }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
    .seeded-prompt { margin: 0; font-size: .75rem; color: var(--mut) }
    .project-form { display: flex; flex-direction: column; gap: 1rem }
    .footer { display: flex; align-items: center; justify-content: space-between }
    .footer-note { font-size: .75rem; color: var(--mut) }
    .back { margin-right: auto }
    .mono { font-family: var(--mono) }
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
})
export class OnboardingComponent {
  private readonly api = inject(FleetApiService);
  private readonly router = inject(Router);
  private readonly versions = inject(VersionsService);
  // AppRoot hands over the URL the user was redirected from when the daemon was unreachable.
  private readonly returnUrl = requestedUrlFrom(inject(Location).getState());

  protected readonly returnUrlTree = this.router.parseUrl(this.returnUrl);
  protected readonly deferredStepLabel = DEFERRED_STEP_LABEL;
  protected readonly startDaemonCommand = START_DAEMON_COMMAND;
  private readonly firstSessionSeed = inject(EmbeddedSessionSeed);
  protected readonly seededPrompt = FIRST_SESSION_SEEDED_PROMPT;
  protected readonly daemonAddress = environment.daemonAddress;

  private readonly firstSessionForm = viewChild(NewSessionFormComponent);
  protected readonly isCreatingFirstSession = computed(() => this.firstSessionForm()?.isPending() ?? false);
  protected readonly currentStepId = signal<StepId>('daemon');
  protected readonly repositoryPath = signal('');
  protected readonly hasRepositoryPath = computed(() => this.repositoryPath().trim() !== '');
  protected readonly hasCopiedCommand = signal(false);
  protected readonly copyFailureMessage = signal('');
  protected readonly copyStatusMessage = computed(() => this.copyFailureMessage() || (this.hasCopiedCommand() ? COPIED_ANNOUNCEMENT : ''));
  protected readonly support = inject(SupportActions);
  protected readonly manualCardTitle = computed(() => (this.showsFailureCard() ? MANUAL_CARD_TITLE_AFTER_FAILURE : `No daemon on ${this.daemonAddress}`));
  protected readonly steps = computed(() => {
    const currentIndex = STEPS.findIndex((step) => step.id === this.currentStepId());
    return STEPS.map((step, index) => {
      const isCurrent = index === currentIndex;
      const isDone = step.isBuilt && index < currentIndex;
      const state = isCurrent ? 'current' : isDone ? 'done' : 'upcoming';
      const mark = isCurrent ? '●' : isDone ? '✓' : '○';
      return { ...step, isCurrent, state, mark };
    });
  });

  private readonly daemon = inject(DaemonStatusService);
  private readonly failureHeading = viewChild<ElementRef<HTMLElement>>('failureHeading');
  private hasStartedLeavingDaemonStep = false;
  private isDestroyed = false;

  protected readonly slowStartCopy = SLOW_START_COPY;
  protected readonly checkResult = signal('');
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
  private readonly observedStatus = computed(() => {
    const status = this.daemon.status();
    return status.state === 'unavailable' ? null : status;
  });

  constructor() {
    this.firstSessionSeed.name.set(FIRST_SESSION_NAME);
    this.firstSessionSeed.prompt.set(FIRST_SESSION_SEEDED_PROMPT);
    inject(DestroyRef).onDestroy(() => {
      this.isDestroyed = true;
    });
    effect(() => this.failureHeading()?.nativeElement.focus());
    effect((onCleanup) => {
      const isWaitingOnDaemonStep = this.currentStepId() === 'daemon';
      if (!isWaitingOnDaemonStep || !this.isDaemonUp()) return;
      const advanceTimer = setTimeout(() => void this.leaveOnceDaemonAnswersHealth(), DAEMON_READY_BEAT_MS);
      onCleanup(() => clearTimeout(advanceTimer));
    });
    effect((onCleanup) => {
      const isWaitingForDaemon = this.currentStepId() === 'daemon';
      if (!isWaitingForDaemon) return;
      let hasLeftDaemonStep = false;
      let nextCheckTimer: ReturnType<typeof setTimeout> | undefined;
      const checkDaemonThenScheduleNextCheck = async () => {
        const health = await this.api.health().catch(() => null);
        if (hasLeftDaemonStep) return;
        if (health) {
          this.versions.recordDaemonHealth(health);
          return this.leaveDaemonStep(() => hasLeftDaemonStep);
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
      return this.leaveDaemonStep(() => this.isDestroyed);
    }
    if (!this.isDaemonUp()) this.checkResult.set(STILL_NOT_RUNNING_COPY);
  }

  private async leaveOnceDaemonAnswersHealth(): Promise<void> {
    const freshHealth = await this.api.health().catch(() => null);
    if (this.isDestroyed) return;
    if (!freshHealth) return void this.daemon.refresh();
    this.versions.recordDaemonHealth(freshHealth);
    await this.leaveDaemonStep(() => this.isDestroyed);
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

  protected continueToFirstSession(): void {
    if (!this.hasRepositoryPath()) return;
    this.firstSessionSeed.directory.set(this.repositoryPath().trim());
    this.currentStepId.set('first-session');
  }

  protected backToProject(): void {
    if (this.isCreatingFirstSession()) return;
    this.showProjectStep();
  }

  // A returning user (deep link, or a fleet that already has sessions) goes back to the app;
  // only a first run with an empty fleet continues with the project.
  private async leaveDaemonStep(hasLeftDaemonStep: () => boolean): Promise<void> {
    if (this.hasStartedLeavingDaemonStep) return;
    this.hasStartedLeavingDaemonStep = true;
    const isDeepLink = this.returnUrl !== APP_HOME_URL;
    const isReturningUser = isDeepLink || (await this.fleetHasSessions());
    if (hasLeftDaemonStep()) return;
    if (isReturningUser) await this.router.navigateByUrl(this.returnUrl).then((isOpened) => isOpened || this.showProjectStep(), () => this.showProjectStep());
    else this.showProjectStep();
  }

  private showProjectStep(): void {
    this.currentStepId.set('project');
  }

  private fleetHasSessions(): Promise<boolean> {
    return this.api.listSessions().then(
      (sessions) => Array.isArray(sessions) && sessions.length > 0,
      () => false,
    );
  }
}
