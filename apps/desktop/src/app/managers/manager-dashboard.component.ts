import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { MANAGER_ROLE, type ManagerView, type Project, type ReopenMode, type Session } from '@openfleet/shared';
import { compactElapsedLabel, elapsedSecondsSince } from '../design/elapsed-time';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { showInvisibleControlsAsEscapes } from '../core/bidi-escapes';
import { ErrorLineComponent } from '../design/error-line.component';
import { StateChipComponent } from '../design/state-chip.component';
import { PulseRingComponent } from '../design/pulse-ring.component';
import { restoreFocusWhenFree } from '../sessions/handoff/handoff-focus';
import { HandoffPreviewHostComponent } from '../sessions/handoff/handoff-preview-host.component';
import { OverdueChipComponent } from '../working-state/overdue-chip.component';
import { countdownLabel, countdownSecondsUntil } from './manager-countdown';
import { ManagerGovernanceComponent } from './manager-governance.component';
import { ManagerLinksComponent } from './manager-links.component';
import { ManagerProfileComponent } from './manager-profile.component';
import { ManagerReopenAction } from './manager-reopen';
import { PulseNowAction } from './pulse-now';
import { PAUSED_COUNTDOWN_PLACEHOLDER, PAUSED_WAKE_LINE, PULSES_PAUSED_HEADER, PulsePauseAction, pauseButtonGlyph } from './pulse-pause';

const REOPEN_EXPLANATION =
  'Reopen starts a fresh conversation seeded with the mission; Resume continues the previous one. Reopening replaces the saved conversation id, so Resume only resumes the latest.';
const HANDOFF_TARGET_AVAILABLE_HINT = 'Saved handoffs appear in Notes › handoffs and in the New-session picker.';

@Component({
  selector: 'of-manager-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StateChipComponent, PulseRingComponent, OverdueChipComponent, HandoffPreviewHostComponent, ErrorLineComponent, ManagerGovernanceComponent, ManagerLinksComponent, ManagerProfileComponent],
  template: `
    @if (!hasSnapshot()) {
      <div class="skeleton" role="status" aria-label="Loading the manager" aria-busy="true" data-testid="manager-dashboard-loading">
        <div class="skeleton-header" data-testid="manager-skeleton-header" aria-hidden="true"></div>
        <div class="skeleton-body" data-testid="manager-skeleton-body" aria-hidden="true"></div>
      </div>
    } @else if (session(); as session) {
      @if (session.role === managerRole) {
        <header class="header" data-testid="manager-dashboard">
          <span class="emoji">{{ session.emoji }}</span>
          <div class="identity">
            <div class="name-row">
              <span data-testid="manager-dashboard-name" class="name" [attr.title]="visibleNameOf(session)">{{ visibleNameOf(session) }}</span>
              @if (projectName(); as projectName) {
                <span class="project-name" data-testid="manager-dashboard-project">{{ projectName }}</span>
              }
              <of-state-chip [state]="session.state" />
              <of-overdue-chip [session]="session" />
            </div>
            <div class="meta-line mono" data-testid="manager-dashboard-meta">
              <span>{{ session.harness }}</span>
              <span> · </span>
              <span>{{ session.model || '—' }}</span>
              <span> · </span>
              <span data-testid="manager-dashboard-last-activity">last activity {{ lastActivityLabel() }}</span>
            </div>
            @if (manager(); as linkedManager) {
              @if (linkedManager.missionNoteId || linkedManager.logStoreId) {
                <nav class="links-line" aria-label="Mission note and log table" data-testid="manager-dashboard-links">
                  <of-manager-links [manager]="linkedManager" [projectId]="session.projectId" [managerName]="session.name" />
                </nav>
              }
            }
          </div>
          <div class="actions">
            <button
              #handoffButton
              type="button"
              class="of-btn of-btn--secondary"
              data-testid="manager-dashboard-write-handoff"
              [attr.aria-expanded]="isHandoffOpen()"
              [attr.aria-controls]="handoffPanelId"
              (click)="toggleHandoff()"
            >Write handoff</button>
            <button
              type="button"
              class="of-btn of-btn--primary"
              data-testid="manager-dashboard-reopen"
              title="Start a new conversation from the manager's mission"
              [disabled]="isReopenUnavailable()"
              (click)="reopen('fresh')"
            >Reopen</button>
            <button
              type="button"
              class="of-btn of-btn--secondary"
              data-testid="manager-dashboard-resume"
              title="Go back into the manager's previous conversation"
              [disabled]="isReopenUnavailable()"
              (click)="reopen('resume')"
            >Resume</button>
          </div>
        </header>
        <div class="reopen-notes">
          <p class="reopen-explanation" data-testid="manager-dashboard-reopen-explanation">${REOPEN_EXPLANATION}</p>
          @if (!isSessionClosed()) {
            <p class="reopen-hint">This manager is running — close it to reopen or resume it.</p>
          }
          @if (reopening.errorText(); as errorText) {
            <of-error-line role="alert" data-testid="manager-dashboard-reopen-error">{{ errorText }}</of-error-line>
          }
        </div>
        @if (isHandoffOpen()) {
          <div [id]="handoffPanelId" data-testid="manager-dashboard-handoff-panel">
            <of-handoff-preview [sessionId]="session.id" density="roomy" subject="manager" [targetAvailableHint]="handoffTargetAvailableHint" (dismissed)="closeHandoff()" />
          </div>
        }

        @if (!isSessionClosed()) {
          <div class="live-controls" data-testid="manager-dashboard-live">
            @if (manager(); as manager) {
              <div class="cap" title="Children cap headroom">
                <span>Children</span>
                <span data-testid="manager-dashboard-cap" class="mono">{{ children().length }}/{{ manager.childrenCap }}</span>
                <div
                  class="cap-bar" role="meter"
                  [attr.aria-valuenow]="children().length" [attr.aria-valuemin]="0" [attr.aria-valuemax]="manager.childrenCap"
                  [attr.aria-label]="children().length + ' of ' + manager.childrenCap + ' children'"
                ><div class="cap-bar-fill" [style.width.%]="capacityPercent()"></div></div>
              </div>
              <div class="pulse">
                <of-pulse-ring [fractionElapsed]="fractionElapsed()" [label]="pulseRingLabel()" />
                <div class="pulse-text">
                  @if (isPaused()) {
                    <span data-testid="manager-dashboard-pulse-header" class="pulse-header">{{ pulsesPausedHeader }}</span>
                  }
                  <span data-testid="manager-dashboard-countdown" class="mono">{{ countdownLabelText() }}</span>
                  @if (isPaused()) {
                    <span data-testid="manager-dashboard-wake" class="paused-wake">{{ pausedWakeLine }}</span>
                  }
                </div>
              </div>
            }
            <button
              type="button"
              class="of-btn of-btn--primary"
              data-testid="manager-dashboard-pulse"
              [disabled]="pulse.pending() || isPaused()"
              (click)="pulseNow()"
            >Pulse now</button>
            <button
              type="button"
              class="of-btn of-btn--secondary"
              [class.of-btn--paused]="isPaused()"
              [attr.aria-label]="pauseButtonName()"
              data-testid="manager-dashboard-pause"
              [attr.aria-pressed]="isPaused()"
              [disabled]="pauseAction.pending()"
              (click)="togglePause()"
            ><span aria-hidden="true">{{ pauseGlyph() }}</span> {{ pauseButtonLabel() }}</button>
            <button
              type="button"
              class="of-btn of-btn--secondary"
              data-testid="manager-dashboard-terminal"
              (click)="openTerminal()"
            >Terminal</button>
            @if (pulse.message() ?? pauseAction.message(); as message) {
              <span
                data-testid="manager-dashboard-pulse-message"
                [attr.role]="message.kind === 'error' ? 'alert' : 'status'"
              >{{ message.text }}</span>
            }
          </div>

          <section class="children">
            <div class="section-head">
              <span class="title">Children</span>
            </div>
            @if (children().length > 0) {
              <div class="table">
                <div class="row head">
                  <span class="col-name">Name</span>
                  <span class="col-state">State</span>
                  <span class="col-cost">Cost</span>
                </div>
                @for (child of children(); track child.id) {
                  <div class="row" [attr.data-testid]="'manager-dashboard-child-' + child.id">
                    <span class="col-name">{{ child.emoji }} {{ visibleNameOf(child) }}</span>
                    <span class="col-state"><of-state-chip [state]="child.state" /></span>
                    <span class="col-cost mono" title="Cost tracking is not implemented yet">—</span>
                  </div>
                }
              </div>
            } @else {
              <p class="empty">No children yet — the manager spawns workers on its next pulse.</p>
            }
          </section>

        }
        <of-manager-profile [session]="session" />
        <of-manager-governance [managerId]="session.id" [projectId]="session.projectId" />
      } @else {
        <div class="state-block" data-testid="manager-dashboard-not-manager">
          <span class="state-headline">This session is not a manager</span>
          <span class="state-detail">It has no pulse, mission or children.</span>
          <button type="button" class="of-btn of-btn--primary" data-testid="manager-dashboard-not-manager-terminal" (click)="openTerminal()">Open its terminal</button>
        </div>
      }
    } @else {
      <div class="state-block" data-testid="manager-dashboard-not-found">
        <span class="state-headline">Manager not found</span>
        <span class="state-detail">This manager no longer exists on this daemon.</span>
        <button type="button" class="of-btn of-btn--secondary" data-testid="manager-dashboard-not-found-back" (click)="backToSessions()">Back to sessions</button>
      </div>
    }
  `,
  styles: `
    .header { display: flex; align-items: center; flex-wrap: wrap; gap: .625rem .75rem; padding: .875rem 1.25rem .5rem; background: var(--panel) }
    .actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; margin-left: auto }
    .reopen-notes { display: flex; flex-direction: column; gap: .5rem; padding: 0 1.25rem .875rem; border-bottom: 1px solid var(--line); background: var(--panel); margin-bottom: 1.25rem }
    .reopen-notes p { margin: 0 }
    .reopen-explanation { font-size: .75rem; color: var(--mut) }
    .live-controls { display: flex; align-items: center; flex-wrap: wrap; gap: .625rem .75rem; margin: 0 1.25rem }
    .emoji { width: 2.5rem; height: 2.5rem; border-radius: .5rem; border: 1px solid var(--line); background: var(--sunk); display: flex; align-items: center; justify-content: center; font-size: 1.25rem }
    .identity { display: flex; flex-direction: column; min-width: 0 }
    .name-row { display: flex; align-items: center; gap: .5rem; min-width: 0 }
    .name { font-size: 1rem; font-weight: 600; min-width: 0; overflow-wrap: anywhere }
    .project-name { font-size: .75rem; color: var(--mut) }
    .meta-line { font-size: .75rem; color: var(--mut) }
    .links-line { display: flex; align-items: center; gap: .625rem; margin-top: .25rem; font-size: .75rem }
    .reopen-hint { font-size: .75rem; color: var(--mut) }
    .cap { display: flex; flex-direction: column; gap: .25rem; width: 8rem; font-size: .6875rem; color: var(--mut) }
    .cap-bar { height: .375rem; border-radius: .25rem; background: var(--sunk); overflow: hidden }
    .cap-bar-fill { height: 100%; background: var(--accent) }
    .pulse { display: flex; align-items: center; gap: .5rem; font-size: .6875rem }
    .pulse-text { display: flex; flex-direction: column; line-height: 1.3 }
    .pulse-header { color: var(--mut) }
    .paused-wake { color: var(--state-waiting-permission) }
    .mono { font-family: var(--mono) }
    .children { margin: 1.25rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel) }
    .section-head { display: flex; align-items: center; padding: .625rem .875rem; border-bottom: 1px solid var(--line) }
    .title { font-weight: 600; flex: 1 }
    .table { display: flex; flex-direction: column }
    .row { display: flex; align-items: center; gap: .5rem; padding: .5rem .875rem; border-bottom: 1px solid var(--line); font-size: .75rem }
    .row.head { color: var(--mut); font-size: .6875rem }
    .col-name { flex: 1.5; display: flex; align-items: center; gap: .375rem; font-weight: 500 }
    .col-state { flex: 1 }
    .col-cost { width: 4rem; text-align: right }
    .empty { padding: 2rem; text-align: center; color: var(--mut) }
    .skeleton { display: flex; flex-direction: column; gap: 1.25rem }
    .skeleton-header { height: 4.5rem; background: var(--sunk); border-bottom: 1px solid var(--line) }
    .skeleton-body { height: 14rem; margin: 0 1.25rem; border-radius: .625rem; background: var(--sunk) }
    .state-block { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .375rem; padding: 4rem 1rem; text-align: center; color: var(--mut) }
    .state-headline { color: var(--fg); font-weight: 600 }
    .state-block .of-btn { margin-top: .5rem }
  `,
})
export class ManagerDashboardComponent {
  protected readonly managerRole = MANAGER_ROLE;
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  protected readonly pulse = new PulseNowAction(this.api);
  protected readonly pauseAction = new PulsePauseAction(this.api);
  protected readonly reopening = new ManagerReopenAction(this.api);
  private readonly managerId = toSignal(this.route.paramMap.pipe(map((params) => params.get('id') ?? '')), { initialValue: '' });
  private readonly now = signal(Date.now());

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
    void this.loadProjects();
    // A card's PulseNowAction is created once per component instance; navigating from one
    // manager to another reuses that instance, so its pending/message state must reset by hand.
    effect(() => {
      this.managerId();
      this.pulse.reset();
      this.pauseAction.reset();
      this.reopening.reset();
    });
    // The same reuse must not leave the preview of one manager over another.
    effect(() => {
      this.managerId();
      untracked(() => this.isHandoffOpen.set(false));
    });
  }

  private async loadProjects(): Promise<void> {
    try {
      this.projects.set((await this.api.listProjects()).items);
    } catch {
      // The header simply omits the project name.
    }
  }

  protected readonly handoffPanelId = 'manager-dashboard-handoff-panel';
  protected readonly handoffTargetAvailableHint = HANDOFF_TARGET_AVAILABLE_HINT;
  protected readonly isHandoffOpen = signal(false);
  private readonly handoffButton = viewChild<ElementRef<HTMLButtonElement>>('handoffButton');
  private readonly injector = inject(Injector);

  protected toggleHandoff(): void {
    if (this.isHandoffOpen()) return this.closeHandoff();
    this.isHandoffOpen.set(true);
  }

  protected closeHandoff(): void {
    this.isHandoffOpen.set(false);
    restoreFocusWhenFree({ target: () => this.handoffButton()?.nativeElement, injector: this.injector });
  }

  protected readonly hasSnapshot = computed(() => this.events.snapshotReceived());

  protected readonly session = computed<Session | undefined>(() =>
    this.events.sessions().find((s) => s.id === this.managerId()),
  );

  protected readonly manager = computed<ManagerView | undefined>(() =>
    this.events.managers().find((m) => m.sessionId === this.managerId()),
  );

  protected readonly children = computed<Session[]>(() =>
    this.events.sessions().filter((s) => s.parentId === this.managerId()),
  );

  protected visibleNameOf(session: Session): string {
    return showInvisibleControlsAsEscapes(session.name);
  }

  protected readonly countdownSeconds = computed(() => {
    const manager = this.manager();
    return manager ? countdownSecondsUntil(manager.nextPulseAt, this.now()) : null;
  });

  private readonly projects = signal<readonly Project[]>([]);

  protected readonly projectName = computed(() => this.projects().find((project) => project.id === this.session()?.projectId)?.name);

  protected readonly lastActivityLabel = computed(() => {
    const stateSince = this.session()?.stateSince;
    const elapsed = stateSince === undefined ? null : compactElapsedLabel(elapsedSecondsSince(stateSince, this.now()));
    return elapsed === null ? '—' : `${elapsed} ago`;
  });

  protected readonly isSessionClosed = computed(() => this.session()?.state === 'closed');

  protected readonly isPaused = computed(() => this.manager()?.pulseEnabled === false);

  protected readonly pulsesPausedHeader = PULSES_PAUSED_HEADER;

  protected readonly pausedWakeLine = PAUSED_WAKE_LINE;

  protected readonly pulseRingLabel = computed(() => (this.isPaused() ? PULSES_PAUSED_HEADER : 'Next pulse'));

  protected readonly pauseGlyph = computed(() => pauseButtonGlyph(this.isPaused()));

  protected readonly pauseButtonLabel = computed(() => (this.isPaused() ? 'Resume pulses' : 'Pause pulses'));

  protected readonly pauseButtonName = computed(() => {
    const managerName = this.session()?.name;
    return managerName === undefined ? null : `${this.pauseButtonLabel()} of ${showInvisibleControlsAsEscapes(managerName)}`;
  });

  protected readonly countdownLabelText = computed(() => (this.isPaused() ? PAUSED_COUNTDOWN_PLACEHOLDER : countdownLabel(this.countdownSeconds())));

  protected readonly fractionElapsed = computed(() => {
    const manager = this.manager();
    const secondsRemaining = this.countdownSeconds();
    if (!manager || this.isPaused() || manager.pulseSeconds <= 0 || secondsRemaining === null) return 0;
    return Math.min(1, Math.max(0, 1 - secondsRemaining / manager.pulseSeconds));
  });

  protected readonly capacityPercent = computed(() => {
    const manager = this.manager();
    if (!manager || manager.childrenCap <= 0) return 0;
    return Math.min(100, (this.children().length / manager.childrenCap) * 100);
  });

  protected readonly isReopenUnavailable = computed(() => this.reopening.pending() || !this.isSessionClosed());

  protected reopen(mode: ReopenMode): void {
    void this.reopening.run({ sessionId: this.managerId(), mode });
  }

  pulseNow(): void {
    this.pauseAction.message.set(null);
    void this.pulse.run(this.managerId());
  }

  protected togglePause(): void {
    const manager = this.manager();
    if (!manager) return;
    this.pulse.message.set(null);
    void this.pauseAction.toggle(manager);
  }

  openTerminal(): void {
    void this.router.navigate(['/session', this.managerId()]);
  }

  backToSessions(): void {
    void this.router.navigate(['/']);
  }
}
