import { Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { environment } from '../../environments/environment';
import { FleetApiService } from '../core/fleet-api.service';
import { NewSessionFormComponent } from '../sessions/new-session-form.component';

type StepId = 'daemon' | 'providers' | 'project' | 'playbooks' | 'team' | 'first-session';

const HEALTH_POLL_INTERVAL_MS = 2000;
const APP_HOME_URL = '/';
const START_DAEMON_COMMAND = 'pnpm dev:core';
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
  template: `
    <div class="page" data-testid="onboarding">
      <div class="topbar"><a [routerLink]="returnUrlTree" class="skip">Skip to app →</a></div>

      <ol class="stepper" aria-label="Setup steps">
        @for (step of steps(); track step.id) {
          <li class="step" [attr.aria-current]="step.isCurrent ? 'step' : null" [attr.aria-disabled]="step.isBuilt ? null : 'true'" [attr.data-state]="step.state">
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
              <div class="card">
                <div class="card-head"><span class="dot"></span><span>Daemon not found</span><span class="spacer"></span><span class="mono address">{{ daemonAddress }}</span></div>
                <span class="hint">Start the daemon: <code>{{ startDaemonCommand }}</code> in the OpenFleet folder. The first start creates <code>~/.openfleet/admin.token</code>; the app reads it by itself.</span>
                <div class="command-row">
                  <div class="terminal">$ {{ startDaemonCommand }}</div>
                  <button type="button" class="of-btn of-btn--secondary" (click)="copyCommand()">{{ hasCopiedCommand() ? 'Copied' : 'Copy command' }}</button>
                </div>
                <span class="fine-print" role="status">{{ copyFailureMessage() }}</span>
                <span class="fine-print">Checking again every 2 s…</span>
              </div>
            </section>
          }
          @case ('project') {
            <section class="step-panel" data-testid="onboarding-step-project">
              <header>
                <span class="kicker">Step 3 of 6 · Project</span>
                <h1>Define the project</h1>
                <p>Sessions run in your repository. Type its path — folder discovery is not available yet.</p>
              </header>
              <form class="card" (ngSubmit)="continueToFirstSession()">
                <label class="of-field">
                  <span class="of-label">Repository path</span>
                  <input class="of-input" name="repositoryPath" [ngModel]="repositoryPath()" (ngModelChange)="repositoryPath.set($event)" placeholder="/path/to/repository" />
                </label>
                <div class="actions"><button type="submit" class="of-btn of-btn--primary" [disabled]="!hasRepositoryPath()">Continue</button></div>
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
              <of-new-session-form [embedded]="true" [initialDirectory]="repositoryPath().trim()" [initialName]="firstSessionName" [seededPrompt]="seededPrompt" />
              <div class="actions actions--start"><button type="button" class="of-btn of-btn--secondary" (click)="backToProject()">Back</button></div>
            </section>
          }
        }
      </div>
    </div>
  `,
  styles: `
    :host { display: flex; flex: 1; min-width: 0; min-height: 0 }
    .page { display: flex; flex: 1; flex-direction: column; min-width: 0; background: var(--bg); color: var(--fg) }
    .topbar { display: flex; justify-content: flex-end; align-items: center; height: 2.75rem; padding: 0 .875rem }
    .skip { color: var(--mut); font-size: .75rem; text-decoration: none }
    .skip:focus-visible { outline: 2px solid var(--accent); outline-offset: .125rem }
    .stepper { display: flex; align-items: flex-start; gap: .25rem; width: 56rem; max-width: 100%; margin: 0 auto; padding: 0 2rem .5rem; box-sizing: border-box; list-style: none }
    .step { display: flex; flex: 1 1 0; flex-direction: column; gap: .375rem; min-width: 0; font-size: .6875rem; color: var(--faint) }
    .step .bar { height: .25rem; border-radius: .125rem; background: var(--line) }
    .step-name { display: flex; align-items: center; gap: .25rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
    .step-later { font-size: .625rem; color: var(--faint) }
    .step[data-state='done'] { color: var(--mut) }
    .step[data-state='done'] .bar { background: var(--state-idle) }
    .step[data-state='current'] { color: var(--fg) }
    .step[data-state='current'] .bar { background: var(--accent) }
    .content { display: flex; flex: 1; justify-content: center; min-height: 0; overflow: auto; padding: 1rem 2rem 2rem }
    .step-panel { display: flex; flex-direction: column; gap: 1rem; width: 56rem; max-width: 100% }
    header { display: flex; flex-direction: column; gap: .25rem }
    .kicker { font-size: .75rem; color: var(--mut) }
    h1 { margin: 0; font-size: 1.375rem; font-weight: 600; letter-spacing: -.015em }
    header p { margin: 0; color: var(--mut); font-size: .875rem }
    .card { display: flex; flex-direction: column; gap: .625rem; padding: 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel) }
    .card-head { display: flex; align-items: center; gap: .5rem; font-weight: 500 }
    .card-head .dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--state-waiting-permission) }
    .spacer { flex: 1 }
    .address { font-size: .6875rem; color: var(--mut) }
    .hint { font-size: .75rem; color: var(--mut) }
    code { padding: 0 .25rem; border-radius: .25rem; background: var(--sunk); font-family: var(--mono) }
    .command-row { display: flex; align-items: center; gap: .5rem }
    .terminal { flex: 1; padding: .5rem .75rem; border-radius: .375rem; background: var(--term-bg); color: var(--term-fg); font-family: var(--mono); font-size: .75rem }
    .command-row .of-btn { height: 2rem; padding: 0 .75rem; white-space: nowrap }
    .fine-print { font-size: .6875rem; color: var(--faint) }
    .of-field { display: flex; flex-direction: column; gap: .25rem }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
    .seeded-prompt { margin: 0; font-size: .75rem; color: var(--mut) }
    .actions { display: flex; justify-content: flex-end }
    .actions--start { justify-content: flex-start }
    .actions .of-btn { height: 2rem; padding: 0 1rem }
    .mono { font-family: var(--mono) }
  `,
})
export class OnboardingComponent {
  private readonly api = inject(FleetApiService);
  private readonly router = inject(Router);
  // AppRoot hands over the URL the user was redirected from when the daemon was unreachable.
  private readonly returnUrl = requestedUrlFrom(inject(Location).getState());

  protected readonly returnUrlTree = this.router.parseUrl(this.returnUrl);
  protected readonly deferredStepLabel = DEFERRED_STEP_LABEL;
  protected readonly startDaemonCommand = START_DAEMON_COMMAND;
  protected readonly firstSessionName = FIRST_SESSION_NAME;
  protected readonly seededPrompt = FIRST_SESSION_SEEDED_PROMPT;
  protected readonly daemonAddress = environment.daemonAddress;

  protected readonly currentStepId = signal<StepId>('daemon');
  protected readonly repositoryPath = signal('');
  protected readonly hasRepositoryPath = computed(() => this.repositoryPath().trim() !== '');
  protected readonly hasCopiedCommand = signal(false);
  protected readonly copyFailureMessage = signal('');
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

  constructor() {
    effect((onCleanup) => {
      const isWaitingForDaemon = this.currentStepId() === 'daemon';
      if (!isWaitingForDaemon) return;
      let hasLeftDaemonStep = false;
      let nextCheckTimer: ReturnType<typeof setTimeout> | undefined;
      const checkDaemonThenScheduleNextCheck = async () => {
        const isDaemonUp = await this.api.health().then(
          () => true,
          () => false,
        );
        if (hasLeftDaemonStep) return;
        if (isDaemonUp) return this.leaveDaemonStep(() => hasLeftDaemonStep);
        nextCheckTimer = setTimeout(() => void checkDaemonThenScheduleNextCheck(), HEALTH_POLL_INTERVAL_MS);
      };
      onCleanup(() => {
        hasLeftDaemonStep = true;
        clearTimeout(nextCheckTimer);
      });
      untracked(() => void checkDaemonThenScheduleNextCheck());
    });
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
    this.currentStepId.set('first-session');
  }

  protected backToProject(): void {
    this.currentStepId.set('project');
  }

  // A returning user (deep link, or a fleet that already has sessions) goes back to the app;
  // only a first run with an empty fleet continues with the project.
  private async leaveDaemonStep(hasLeftDaemonStep: () => boolean): Promise<void> {
    const isDeepLink = this.returnUrl !== APP_HOME_URL;
    const isReturningUser = isDeepLink || (await this.fleetHasSessions());
    if (hasLeftDaemonStep()) return;
    if (isReturningUser) await this.router.navigateByUrl(this.returnUrl);
    else this.currentStepId.set('project');
  }

  private fleetHasSessions(): Promise<boolean> {
    return this.api.listSessions().then(
      (sessions) => sessions.length > 0,
      () => false,
    );
  }
}
