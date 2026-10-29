import { Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { Project } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { EmbeddedSessionSeed } from '../sessions/new-session-form.component';
import { DaemonStepComponent } from './daemon-step.component';
import { FirstSessionStepComponent } from './first-session-step.component';
import { ProjectStepComponent } from './project-step.component';

type StepId = 'daemon' | 'providers' | 'project' | 'playbooks' | 'team' | 'first-session';

const APP_HOME_URL = '/';
const DEFERRED_STEP_LABEL = 'Available in a later phase';
const REMEMBERED_PROJECT_KEY = 'openfleet.onboarding.projectId';
const REMEMBERED_REPOSITORY_PATH_KEY = 'openfleet.onboarding.repositoryPath';

function guardedStorage<Result>(access: () => Result, fallback: Result): Result {
  try {
    return access();
  } catch {
    return fallback;
  }
}

const rememberedValues = {
  read: (key: string): string | null => guardedStorage(() => localStorage.getItem(key), null),
  write: (key: string, value: string): void => guardedStorage(() => localStorage.setItem(key, value), undefined),
  forget: (key: string): void => guardedStorage(() => localStorage.removeItem(key), undefined),
};

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
  imports: [RouterLink, DaemonStepComponent, ProjectStepComponent, FirstSessionStepComponent],
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
            <of-daemon-step (daemonAnswered)="leaveDaemonStep()" />
          }
          @case ('project') {
            <of-project-step
              [savedProject]="savedProject()"
              [(repositoryPath)]="repositoryPath"
              (projectSaved)="rememberProject($event)"
              (cancelled)="cancelProjectSetup()"
              (continued)="continueToFirstSession()"
            />
          }
          @case ('first-session') {
            <of-first-session-step (back)="showProjectStep()" />
          }
        }
      </div>
    </div>
  `,
  styles: [
    `
    :host { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0 }
    .page { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg); color: var(--fg) }
    .topbar { display: flex; flex: none; justify-content: flex-end; align-items: center; height: 2.75rem; padding: 0 .875rem }
    .skip { color: var(--mut); font-size: .75rem; text-decoration: none }
    .skip:focus-visible { outline: .125rem solid var(--accent); outline-offset: .125rem }
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
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
    .mono { font-family: var(--mono) }
  `,
  ],
})
export class OnboardingComponent {
  private readonly api = inject(FleetApiService);
  private readonly router = inject(Router);
  // AppRoot hands over the URL the user was redirected from when the daemon was unreachable.
  private readonly returnUrl = requestedUrlFrom(inject(Location).getState());

  protected readonly returnUrlTree = this.router.parseUrl(this.returnUrl);
  protected readonly deferredStepLabel = DEFERRED_STEP_LABEL;
  private readonly firstSessionSeed = inject(EmbeddedSessionSeed);

  protected readonly currentStepId = signal<StepId>('daemon');
  protected readonly repositoryPath = signal('');
  protected readonly savedProject = signal<Project | undefined>(undefined);
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

  private hasStartedLeavingDaemonStep = false;
  private isDestroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.isDestroyed = true;
    });
  }

  protected rememberProject(project: Project): void {
    this.savedProject.set(project);
    this.firstSessionSeed.projectId.set(project.id);
    rememberedValues.write(REMEMBERED_PROJECT_KEY, project.id);
    rememberedValues.write(REMEMBERED_REPOSITORY_PATH_KEY, this.repositoryPath());
  }

  protected cancelProjectSetup(): void {
    void this.router.navigateByUrl(this.returnUrl);
  }

  protected continueToFirstSession(): void {
    rememberedValues.forget(REMEMBERED_PROJECT_KEY);
    rememberedValues.forget(REMEMBERED_REPOSITORY_PATH_KEY);
    this.firstSessionSeed.directory.set(this.repositoryPath().trim());
    this.currentStepId.set('first-session');
  }

  // A returning user (deep link, or a fleet that already has sessions) goes back to the app;
  // only a first run with an empty fleet continues with the project.
  protected async leaveDaemonStep(): Promise<void> {
    if (this.hasStartedLeavingDaemonStep) return;
    this.hasStartedLeavingDaemonStep = true;
    const isDeepLink = this.returnUrl !== APP_HOME_URL;
    const isReturningUser = isDeepLink || (await this.fleetHasSessions());
    if (this.isDestroyed) return;
    if (isReturningUser) await this.router.navigateByUrl(this.returnUrl).then((isOpened) => isOpened || this.showProjectStep(), () => this.showProjectStep());
    else await this.resumeThenShowProjectStep();
  }

  private async resumeThenShowProjectStep(): Promise<void> {
    await this.resumeRememberedProject();
    if (!this.isDestroyed) this.showProjectStep();
  }

  /** Finds again, on the daemon, the project this onboarding created before a reload; a project the daemon no longer has is forgotten. */
  private async resumeRememberedProject(): Promise<void> {
    const rememberedProjectId = rememberedValues.read(REMEMBERED_PROJECT_KEY);
    if (rememberedProjectId === null || this.savedProject()) return;
    const { items: projects } = await this.api.listProjects().catch(() => ({ items: [] as Project[] }));
    const rememberedProject = projects.find((project) => project.id === rememberedProjectId);
    if (!rememberedProject || this.isDestroyed) return;
    this.repositoryPath.set(rememberedValues.read(REMEMBERED_REPOSITORY_PATH_KEY) ?? '');
    this.rememberProject(rememberedProject);
  }

  protected showProjectStep(): void {
    this.currentStepId.set('project');
  }

  private fleetHasSessions(): Promise<boolean> {
    return this.api.listSessions().then(
      (sessions) => Array.isArray(sessions) && sessions.length > 0,
      () => false,
    );
  }
}
