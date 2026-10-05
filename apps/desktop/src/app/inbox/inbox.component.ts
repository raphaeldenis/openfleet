import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MANAGER_ROLE } from '@openfleet/shared';
import { ReplyDraftStore } from '../sessions/reply-draft.store';
import { detailsTextOf } from '../core/copy-details';
import { decideApproval } from '../core/decide-approval';
import { copyOfEnvelope } from '../core/error-copy';
import { CopyDetailsButtonComponent } from '../design/copy-details-button.component';
import { compactElapsedLabel, elapsedSecondsSince } from '../design/elapsed-time';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService, silentBlockKey } from '../core/fleet-events.service';
import { VersionsService } from '../core/versions.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { KindBadgeComponent } from '../design/kind-badge.component';
import { focusTabAt, nextTabIndex } from '../design/tablist-keyboard';
import { AnsweredRepliesStore } from '../working-state/answered-replies.store';
import { answeredItemsOf, attentionItemsOf, inboxCountLabelOf, itemsNeedingYouOf } from '../working-state/attention-items';
import { contextNoticeCopyOf, contextNoticesOf } from '../working-state/context-notices';
import { AttentionCardComponent } from './attention-card.component';
import { minutesWaiting, silentBlockCopyOf, silentBlockDetailsMessageOf } from './silent-block-copy';
import { showBidiControlsAsEscapes, showInvisibleControlsAsEscapes } from '../core/bidi-escapes';

type InboxTab = 'gates' | 'questions' | 'proposals';
type FilterKey = 'all' | 'unread' | 'mine' | 'blocked' | 'recent';

interface FilterOption {
  readonly key: FilterKey;
  readonly label: string;
  readonly disabled: boolean;
}

const NEEDS_BACKEND_SUPPORT = 'needs backend support';

// Only "All" runs against real data (the backend has no read-tracking, assignee or blocking
// flag on Approval yet) — the rest stay visible but inert rather than faking client-side heuristics.
const FILTERS: readonly FilterOption[] = [
  { key: 'all', label: 'All', disabled: false },
  { key: 'unread', label: 'Unread', disabled: true },
  { key: 'mine', label: 'Mine', disabled: true },
  { key: 'blocked', label: 'Blocked', disabled: true },
  { key: 'recent', label: 'Recent', disabled: true },
];

const TABS: readonly { readonly key: InboxTab; readonly label: string }[] = [
  { key: 'gates', label: 'Gates' },
  { key: 'questions', label: 'Questions from agents' },
  { key: 'proposals', label: 'Governance proposals' },
];

interface FormattedInput {
  readonly toolInput: unknown;
  readonly text: string;
}

interface IssueItem {
  readonly key: string;
  readonly timeLabel: string;
  readonly copy: string;
  readonly detailsText: string;
  readonly sessionName: string | undefined;
  readonly sessionRoute: readonly string[] | undefined;
  readonly dismiss: () => void;
}

const SILENT_BLOCK_CODE = 'permission_silent_block';

const timeLabelOf = (isoTime: string): string => new Date(isoTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function formatInput(toolInput: unknown): FormattedInput {
  return { toolInput, text: showBidiControlsAsEscapes(JSON.stringify(toolInput, null, 2) ?? '') };
}

@Component({
  selector: 'of-inbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, KindBadgeComponent,AttentionCardComponent, CopyDetailsButtonComponent, RouterLink],
  template: `
    <section class="inbox" data-testid="inbox">
      <header class="title-row" data-testid="inbox-title-row">
        <h1 class="title" tabindex="-1" data-testid="inbox-title">Inbox @if (pendingCount(); as pending) {<span class="count" data-testid="inbox-count" role="img" [attr.aria-label]="pending.ariaLabel">{{ pending.text }}</span>}</h1>
        @if (tab() === 'gates') {
          <div class="filters" data-testid="inbox-filters">
            @for (filter of filters; track filter.key) {
              <button
                type="button"
                class="filter-chip"
                [class.active]="filter.key === 'all'"
                [disabled]="filter.disabled"
                [title]="filter.disabled ? needsBackendSupport : null"
                [attr.data-testid]="'inbox-filter-' + filter.key"
              >{{ filter.label }}</button>
            }
          </div>
        }
      </header>
      @for (failure of unseenReplyFailures(); track failure.sessionId) {
        <div class="reply-failure" role="alert" data-testid="inbox-reply-failure">
          <p class="reply-failure-title">Your reply to {{ failure.sessionName }} was not sent. Your text is kept here.</p>
          <pre class="reply-failure-draft" data-testid="inbox-reply-failure-draft">{{ failure.draft }}</pre>
          <button type="button" class="of-btn of-btn--secondary of-btn--compact" data-testid="inbox-reply-failure-dismiss" (click)="dismissReplyFailure(failure.sessionId)">Dismiss</button>
        </div>
      }
      @if (issues().length > 0) {
        <ul class="issue-list" aria-label="Issues">
          @for (issue of issues(); track issue.key) {
            <li class="issue" data-testid="inbox-issue">
              <div class="gate-meta">
                <of-kind-badge kind="issue" />
                @if (issue.sessionRoute; as sessionRoute) {
                  <a class="session-label session-link" data-testid="inbox-issue-session" [routerLink]="sessionRoute">{{ issue.sessionName }}</a>
                } @else if (issue.sessionName) {
                  <span class="session-label" data-testid="inbox-issue-session">{{ issue.sessionName }}</span>
                }
                <span class="age">{{ issue.timeLabel }}</span>
              </div>
              <p class="issue-copy" data-testid="inbox-issue-copy">{{ issue.copy }}</p>
              <div class="actions">
                <of-copy-details-button testId="inbox-issue-copy-details" [text]="issue.detailsText" [isCompact]="true" />
                <button type="button" class="of-btn of-btn--secondary of-btn--compact issue-dismiss" data-testid="inbox-issue-dismiss" (click)="dismissIssue(issue)">Dismiss</button>
              </div>
            </li>
          }
        </ul>
      }
      @if (contextNotices().length > 0) {
        <ul class="issue-list" aria-label="Notices">
          @for (notice of contextNotices(); track notice.sessionId) {
            <li class="issue" data-testid="inbox-notice">
              <div class="gate-meta">
                <of-kind-badge kind="notice" />
                <a class="session-label session-link" data-testid="inbox-notice-session" [routerLink]="notice.sessionRoute">{{ notice.sessionName }}</a>
              </div>
              <p class="issue-copy" data-testid="inbox-notice-copy">{{ notice.copy }}</p>
            </li>
          }
        </ul>
      }
      <nav class="tabs" role="tablist" aria-label="Inbox sections" (keydown)="onTabKeydown($event)">
        @for (entry of tabs; track entry.key) {
          <button
            type="button"
            role="tab"
            class="tab"
            [class.active]="tab() === entry.key"
            [id]="'inbox-tab-' + entry.key"
            [attr.aria-selected]="tab() === entry.key"
            [attr.aria-controls]="tabPanelId"
            [attr.tabindex]="tab() === entry.key ? 0 : -1"
            [attr.data-testid]="'inbox-tab-' + entry.key"
            (click)="tab.set(entry.key)"
          >{{ entry.label }}@if (entry.key === 'questions' && attentionItemsNeedingYou().length > 0) { <span class="tab-count" data-testid="inbox-tab-count-questions">{{ attentionItemsNeedingYou().length }}</span>}</button>
        }
      </nav>

      <div class="tabpanel" role="tabpanel" [id]="tabPanelId" [attr.aria-labelledby]="'inbox-tab-' + tab()">
      @switch (tab()) {
        @case ('gates') {
          <div class="gate-list" data-testid="inbox-gate-list">
            @for (item of items(); track item.id) {
              <article class="gate-card" data-testid="inbox-gate-card">
                <span class="avatar" data-testid="inbox-gate-avatar">{{ item.sessionEmoji }}</span>
                <div class="gate-body">
                  <div class="gate-meta" data-testid="inbox-gate-meta">
                    <of-kind-badge kind="gate" />
                    <span class="session-label" data-testid="inbox-gate-session">{{ item.sessionName }}</span>
                    <span class="age" data-testid="inbox-gate-age">{{ item.ageLabel }}</span>
                  </div>
                  <p class="gate-sentence" data-testid="inbox-gate-sentence">Wants to run <code class="tool-name" data-testid="inbox-gate-tool">{{ item.toolName }}</code>.</p>
                  <pre class="tool-args" data-testid="inbox-gate-args">{{ item.formattedInput }}</pre>
                  <div class="actions">
                    <button type="button" class="of-btn of-btn--primary" data-testid="inbox-allow" [disabled]="item.pending" (click)="decide(item.id, 'allow')">Approve</button>
                    <button type="button" class="of-btn of-btn--secondary" data-testid="inbox-deny" [disabled]="item.pending" (click)="decide(item.id, 'deny')">Deny</button>
                  </div>
                  @if (item.error; as error) {
                    <p><of-error-line data-testid="inbox-error" [glyph]="false">{{ error }}</of-error-line></p>
                  }
                </div>
              </article>
            } @empty {
              @if (issues().length === 0 && contextNotices().length === 0) {
                <div class="empty" data-testid="inbox-empty">
                  <span class="empty-title">Nothing needs you</span>
                  <span>Gates, questions, budget incidents and manager proposals show up here.</span>
                </div>
              }
            }
          </div>
        }
        @case ('questions') {
          <div class="gate-list" data-testid="inbox-attention-list">
            @for (item of attentionItemsNeedingYou(); track item.session.id) {
              <of-attention-card [item]="item" />
            } @empty {
              <div class="empty" data-testid="inbox-questions-empty">
                <span class="empty-title">No agent is waiting on you</span>
                <span>A session that asks a question or reports a blocker in its state shows up here.</span>
              </div>
            }
            @if (answeredEntries().length > 0) {
              <section class="answered">
                <button type="button" class="answered-toggle" data-testid="inbox-answered-toggle" [attr.aria-expanded]="isAnsweredSectionOpen()" (click)="isAnsweredSectionOpen.set(!isAnsweredSectionOpen())">Answered ({{ answeredEntries().length }})</button>
                @if (isAnsweredSectionOpen()) {
                  <ul class="answered-list">
                    @for (entry of answeredEntries(); track entry.sessionId) {
                      <li class="answered-entry" data-testid="inbox-answered-entry">
                        <div class="gate-meta">
                          <span class="avatar" aria-hidden="true">{{ entry.sessionEmoji }}</span>
                          <a class="session-label session-link" data-testid="inbox-answered-session" [routerLink]="entry.sessionRoute">{{ entry.sessionName }}</a>
                          <span class="answered-status" data-testid="inbox-answered-status">Reply delivered</span>
                          <span class="age" data-testid="inbox-answered-time">{{ entry.timeLabel }}</span>
                        </div>
                        <ul class="answered-lines">
                          @for (line of entry.lines; track $index) {
                            <li data-testid="inbox-answered-question">{{ line }}</li>
                          }
                        </ul>
                      </li>
                    }
                  </ul>
                }
              </section>
            }
          </div>
        }
        @case ('proposals') {
          <p class="coming" data-testid="inbox-proposals-coming">Governance proposals are coming with phase 4 tables/governance.</p>
        }
      }
      </div>
    </section>
  `,
  styles: `
    :host { display: block; flex: 1; min-width: 0; max-width: 54rem; margin: 0 auto; }
    .inbox { display: flex; flex-direction: column; gap: .75rem; padding: 1rem; width: 100%; box-sizing: border-box; }
    .title-row { display: flex; align-items: center; gap: .375rem; flex-wrap: wrap; }
    .title { margin: 0; flex: 1; font-size: 1.25rem; font-weight: 600; }
    .count { display: inline-flex; min-width: 1rem; height: 1rem; padding: 0 .25rem; margin-left: .5rem; border-radius: .5rem; background: var(--accent-bg); color: var(--fg); font-size: .6875rem; font-weight: 600; align-items: center; justify-content: center; }
    .reply-failure { display: flex; flex-direction: column; align-items: flex-start; gap: .375rem; min-width: 0; padding: .625rem .875rem; border: 1px solid var(--state-error); border-radius: .625rem; background: var(--panel); }
    .reply-failure-title { margin: 0; color: var(--fg); overflow-wrap: anywhere; }
    .reply-failure-draft { margin: 0; max-width: 100%; max-height: 10rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
    .issue-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
    .issue { display: flex; flex-direction: column; gap: .375rem; min-width: 0; padding: .625rem .875rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .issue-copy { margin: 0; overflow-wrap: anywhere; }
    .issue-dismiss { flex: none; }
    .tabs { display: flex; gap: .25rem; border-bottom: 1px solid var(--line); }
    .tab { height: 1.875rem; padding: 0 .75rem; border: 0; border-bottom: 1px solid transparent; background: transparent; color: var(--mut); cursor: pointer; font: inherit; }
    .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .tab.active { color: var(--fg); border-bottom-color: var(--accent); }
    .tab-count { display: inline-flex; min-width: 1rem; height: 1rem; padding: 0 .25rem; margin-left: .25rem; border-radius: .5rem; background: var(--sunk); color: var(--fg); font-size: .6875rem; font-weight: 600; align-items: center; justify-content: center; }
    .answered { display: flex; flex-direction: column; gap: .5rem; padding-top: .5rem; }
    .answered-toggle { align-self: flex-start; padding: 0; border: 0; background: transparent; color: var(--mut); cursor: pointer; font: inherit; }
    .answered-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .answered-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
    .answered-entry { display: flex; flex-direction: column; gap: .25rem; min-width: 0; padding: .5rem .875rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); opacity: .7; }
    .answered-status { font-size: .6875rem; color: var(--mut); }
    .answered-lines { margin: 0; padding: 0 0 0 1rem; overflow-wrap: anywhere; }
    .tabpanel { display: flex; flex-direction: column; gap: .75rem; }
    .filters { display: flex; flex-wrap: wrap; gap: .375rem; }
    .filter-chip { height: 1.625rem; padding: 0 .625rem; border: 1px solid var(--line); border-radius: 1rem; background: var(--panel); color: var(--fg); font-size: .75rem; cursor: pointer; }
    .filter-chip.active { background: var(--active); }
    .filter-chip:disabled { color: var(--mut); cursor: not-allowed; }
    .gate-list { display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
    .gate-card { display: flex; gap: .75rem; min-width: 0; padding: .875rem 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .avatar { display: flex; align-items: center; justify-content: center; flex: none; width: 2rem; height: 2rem; border-radius: .5rem; border: 1px solid var(--line); background: var(--sunk); }
    .gate-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .5rem; }
    .gate-meta { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .session-label { font-weight: 500; }
    .session-link { color: var(--fg); overflow-wrap: anywhere; }
    .session-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .gate-sentence { margin: 0; }
    .tool-name { font-family: var(--mono); font-size: .75rem; padding: 0 .375rem; border-radius: .25rem; background: var(--sunk); }
    .age { margin-left: auto; font-size: .6875rem; color: var(--mut); }
    .tool-args { margin: 0; overflow: auto; max-height: 10rem; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: .75rem; padding: .375rem .5rem; border-radius: .375rem; background-color: var(--term-bg); color: var(--term-fg); border: 1px solid var(--line); background-image: linear-gradient(var(--term-bg), var(--term-bg)), linear-gradient(to top, var(--faint), transparent); background-position: bottom, bottom; background-size: 100% 1.5rem, 100% .75rem; background-repeat: no-repeat; background-attachment: local, scroll; }
    .actions { display: flex; gap: .5rem; }
    .empty { display: flex; flex-direction: column; align-items: center; gap: .375rem; padding: 4rem 1rem; color: var(--mut); }
    .empty-title { color: var(--fg); font-weight: 500; }
    .coming { color: var(--mut); padding: 1rem 0; }
  `,
})
export class InboxComponent {
  readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  private readonly replies = inject(ReplyDraftStore);
  private readonly answeredReplies = inject(AnsweredRepliesStore);
  private readonly versions = inject(VersionsService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly filters = FILTERS;
  protected readonly needsBackendSupport = NEEDS_BACKEND_SUPPORT;
  protected readonly tabs = TABS;
  protected readonly tabPanelId = 'inbox-tabpanel';
  protected readonly tab = signal<InboxTab>('gates');
  private readonly now = signal(Date.now());
  private readonly pendingIds = signal<ReadonlySet<string>>(new Set());
  private readonly errorsById = signal<Readonly<Record<string, string>>>({});

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
    effect(() => {
      const closedSessionIds = this.events.sessions().filter((session) => session.state === 'closed').map((session) => session.id);
      this.replies.failedSessionIds();
      closedSessionIds.forEach((sessionId) => this.replies.discardUnlessFailed(sessionId));
    });
  }

  private formattedInputsById = new Map<string, FormattedInput>();

  private readonly sessionsById = computed(() => new Map(this.events.sessions().map((session) => [session.id, session])));

  private readonly gates = computed(() => {
    const sessionsById = this.sessionsById();
    const previousFormattedInputs = this.formattedInputsById;
    const currentFormattedInputs = new Map<string, FormattedInput>();
    const gates = this.events.approvals().map((approval) => {
      const session = sessionsById.get(approval.sessionId);
      const sessionName = session ? session.name : approval.sessionId;
      const sessionEmoji = session ? session.emoji : '';
      const previous = previousFormattedInputs.get(approval.id);
      const isUnchanged = previous !== undefined && previous.toolInput === approval.toolInput;
      const formattedInput = isUnchanged ? previous : formatInput(approval.toolInput);
      currentFormattedInputs.set(approval.id, formattedInput);
      return {
        ...approval,
        toolName: showBidiControlsAsEscapes(approval.toolName),
        sessionName: showInvisibleControlsAsEscapes(sessionName),
        sessionEmoji,
        formattedInput: formattedInput.text,
      };
    });
    this.formattedInputsById = currentFormattedInputs;
    return gates;
  });

  private readonly attentionItems = computed(() => attentionItemsOf(this.events.sessions(), this.events.workingStates(), this.answeredReplies.answeredReplyBySessionId()));
  protected readonly attentionItemsNeedingYou = computed(() => itemsNeedingYouOf(this.attentionItems()));
  protected readonly isAnsweredSectionOpen = signal(false);

  protected readonly answeredEntries = computed(() =>
    answeredItemsOf(this.attentionItems()).map((item) => ({
      sessionId: item.session.id,
      sessionEmoji: item.session.emoji,
      sessionName: showInvisibleControlsAsEscapes(item.session.name),
      sessionRoute: [item.session.role === MANAGER_ROLE ? '/manager' : '/session', item.session.id],
      timeLabel: timeLabelOf(item.answeredAt ?? item.updatedAt),
      lines: [...item.questions, ...item.blockers].map(showBidiControlsAsEscapes),
    })),
  );

  /** Failed replies whose card is not on screen: the session closed, left the list, or another tab is open. */
  protected readonly unseenReplyFailures = computed(() => {
    const sessionsById = this.sessionsById();
    const cardSessionIds = new Set(this.tab() === 'questions' ? this.attentionItemsNeedingYou().map((item) => item.session.id) : []);
    return this.replies
      .failedSessionIds()
      .filter((sessionId) => !cardSessionIds.has(sessionId))
      .map((sessionId) => {
        const session = sessionsById.get(sessionId);
        return { sessionId, sessionName: showInvisibleControlsAsEscapes(session ? session.name : sessionId), draft: showBidiControlsAsEscapes(this.replies.draftOf(sessionId)) };
      });
  });

  private readonly silentBlockIssues = computed((): IssueItem[] => {
    const sessionsById = this.sessionsById();
    const daemonVersion = this.versions.daemonVersion();
    const nowMs = this.now();
    return this.events.silentBlocks().map((block) => {
      const session = sessionsById.get(block.sessionId);
      const minutes = minutesWaiting(block.waitingSince, nowMs);
      const sessionName = session ? showInvisibleControlsAsEscapes(session.name) : undefined;
      const copy = silentBlockCopyOf({ minutes, sessionName: sessionName ?? 'The session' });
      const detailsText = detailsTextOf({ code: SILENT_BLOCK_CODE, message: silentBlockDetailsMessageOf(minutes), at: block.waitingSince, daemonVersion });
      const sessionRoute = session && [session.role === MANAGER_ROLE ? '/manager' : '/session', session.id];
      return { key: `silent-block:${silentBlockKey(block)}`, timeLabel: timeLabelOf(block.waitingSince), copy, detailsText, sessionName, sessionRoute, dismiss: () => this.events.dismissSilentBlock(silentBlockKey(block)) };
    });
  });

  private readonly backgroundFailureIssues = computed((): IssueItem[] => {
    const sessionsById = this.sessionsById();
    const daemonVersion = this.versions.daemonVersion();
    return this.events.backgroundFailures().map(({ key, sessionId, envelope, at }) => {
      const session = sessionId === undefined ? undefined : sessionsById.get(sessionId);
      const { text, ref } = copyOfEnvelope(envelope, { action: 'generic' });
      const detailsText = detailsTextOf({ ref, code: envelope.error, message: envelope.message, at, daemonVersion });
      return { key, timeLabel: timeLabelOf(at), copy: text, detailsText, sessionName: session && showInvisibleControlsAsEscapes(session.name), sessionRoute: undefined, dismiss: () => this.events.dismissBackgroundFailure(key) };
    });
  });

  protected readonly issues = computed(() => [...this.silentBlockIssues(), ...this.backgroundFailureIssues()]);

  protected readonly contextNotices = computed(() =>
    contextNoticesOf(this.events.sessions()).map(({ session, tokens }) => {
      const sessionName = showInvisibleControlsAsEscapes(session.name);
      const sessionRoute = [session.role === MANAGER_ROLE ? '/manager' : '/session', session.id];
      return { sessionId: session.id, sessionName, sessionRoute, copy: contextNoticeCopyOf({ sessionName, tokens }) };
    }),
  );

  protected dismissReplyFailure(sessionId: string): void {
    this.replies.dismissFailure(sessionId);
    afterNextRender(() => this.focusNextAfterDismiss(), { injector: this.injector });
  }

  protected dismissIssue(issue: IssueItem): void {
    issue.dismiss();
    afterNextRender(() => this.focusNextIssueOrHeading(), { injector: this.injector });
  }

  private focusNextIssueOrHeading(): void {
    const host: HTMLElement = this.host.nativeElement;
    const nextDismiss = host.querySelector<HTMLElement>('[data-testid="inbox-issue-dismiss"]');
    const heading = host.querySelector<HTMLElement>('[data-testid="inbox-title"]');
    (nextDismiss ?? heading)?.focus();
  }

  private focusNextAfterDismiss(): void {
    const host: HTMLElement = this.host.nativeElement;
    const nextDismiss = host.querySelector<HTMLElement>('[data-testid="inbox-reply-failure-dismiss"]');
    const selectedTab = host.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    (nextDismiss ?? selectedTab)?.focus();
  }

  protected readonly pendingCount = computed(() => {
    const count = this.events.approvals().length + this.attentionItemsNeedingYou().length + this.contextNotices().length;
    return count > 0 ? inboxCountLabelOf(count) : undefined;
  });

  readonly items = computed(() =>
    this.gates().map((gate) => ({
      ...gate,
      pending: this.pendingIds().has(gate.id),
      error: this.errorsById()[gate.id],
      ageLabel: compactElapsedLabel(elapsedSecondsSince(gate.createdAt, this.now())),
    })),
  );

  protected onTabKeydown(event: KeyboardEvent): void {
    const currentIndex = TABS.findIndex((entry) => entry.key === this.tab());
    const targetIndex = nextTabIndex(event, { currentIndex, tabCount: TABS.length, orientation: 'horizontal' });
    if (targetIndex === undefined) return;
    event.preventDefault();
    this.tab.set(TABS[targetIndex].key);
    focusTabAt(event.currentTarget as HTMLElement, targetIndex);
  }

  async decide(id: string, behavior: 'allow' | 'deny'): Promise<void> {
    if (this.pendingIds().has(id)) return;
    this.setPending(id, true);
    this.clearError(id);
    const result = await decideApproval(this.api, id, behavior);
    if (result.outcome === 'already-resolved') this.removeFromSharedApprovals(id);
    else if (result.outcome === 'failed') this.setError(id, result.message);
    this.setPending(id, false);
  }

  private setPending(id: string, isPending: boolean): void {
    this.pendingIds.update((ids) => {
      const next = new Set(ids);
      if (isPending) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private setError(id: string, message: string): void {
    this.errorsById.update((errors) => ({ ...errors, [id]: message }));
  }

  private clearError(id: string): void {
    this.errorsById.update((errors) => Object.fromEntries(Object.entries(errors).filter(([key]) => key !== id)));
  }

  private removeFromSharedApprovals(id: string): void {
    this.events.approvals.update((all) => all.filter((approval) => approval.id !== id));
  }
}
