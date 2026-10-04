import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent, Session, SessionState } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { FleetApiService } from '../core/fleet-api.service';
import {
  SWITCH_KINDS,
  type SwitchKind,
  applyButtonOf,
  connectFakeDaemon,
  deferred,
  errorOf,
  leaveSessionHeadersOpen,
  noteOf,
  requestSwitch,
  selectedValueOf,
  settleRequests,
  withoutRealTerminal,
} from '../testing/session-view.testing';

/**
 * QE (P2-U2e) — the session view as a user meets it: the real header, selectors and actions, fed the
 * daemon's own events by the real FleetEventsService reducer, with REST replies the test settles by hand.
 * Every assertion is on what is on screen or which request left the client.
 */

type SwitchReply = { status: 'relaunching' | 'deferred' };

beforeEach(() => leaveSessionHeadersOpen());

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli', emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'generating', stateSince: 't', permissionMode: 'manual', createdAt: 't', ...patch,
  } as Session;
}

const gimli = (patch: Partial<Session> = {}) => session({ id: 's1', name: 'Gimli', ...patch });
const legolas = (patch: Partial<Session> = {}) => session({ id: 's2', name: 'Legolas', state: 'idle', ...patch });

function fakeApi() {
  return {
    updateModel: vi.fn().mockResolvedValue({ status: 'deferred' }),
    updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }),
    renameSession: vi.fn().mockResolvedValue({}),
    decide: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue({ status: 'delivered', messageId: 'm1' }),
    closeSession: vi.fn().mockResolvedValue({}),
    sendInput: vi.fn().mockResolvedValue({}),
    reopenSession: vi.fn().mockResolvedValue({}),
  };
}

@Component({
  selector: 'of-view-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SessionViewComponent],
  template: `@if (visible()) { <of-session-view [sessionId]="sessionId()" /> }`,
})
class ViewHostComponent {
  readonly sessionId = signal('s1');
  readonly visible = signal(true);
}

async function renderFleet(api: ReturnType<typeof fakeApi>, sessions: Session[]) {
  const { fixture } = await render(ViewHostComponent, {
    providers: [{ provide: FleetApiService, useValue: api }],
    ...withoutRealTerminal,
  });
  const host = fixture.componentInstance;
  const fakeDaemon = await connectFakeDaemon(fixture);
  const daemon = {
    ...fakeDaemon,
    setState: (sessionId: string, state: SessionState) => fakeDaemon.send({ type: 'session.state', sessionId, state, stateSince: 't2' }),
  };
  await daemon.send({ type: 'snapshot', sessions, approvals: [], managers: [] });
  const goTo = async (sessionId: string) => {
    host.sessionId.set(sessionId);
    await fixture.whenStable();
  };
  const leaveTheSessionView = async () => {
    host.visible.set(false);
    await fixture.whenStable();
  };
  const comeBackToTheSessionView = async () => {
    host.visible.set(true);
    await fixture.whenStable();
  };
  return { fixture, api, daemon, goTo, leaveTheSessionView, comeBackToTheSessionView };
}

type Daemon = Awaited<ReturnType<typeof renderFleet>>['daemon'];

const modelSwitch = SWITCH_KINDS[0];
const permissionModeSwitch = SWITCH_KINDS[1];

const SWITCH_PENDING_NOTE = 'switch pending';
const RESTARTING_NOTE = 'restarting…';

async function requestClose() {
  await userEvent.click(screen.getByTestId('session-close'));
  await userEvent.click(screen.getByTestId('close-confirm-submit'));
}

const actionError = () => screen.queryByTestId('session-action-error');

// The notes leave through a root effect that settles the pending switch from the daemon's state, then a render: on a loaded
// runner the screen can trail the event, so a note that must disappear is awaited, not read once.
const A_LOADED_RUNNER_RENDER_MS = 3_000;
const noteLeaves = (kind: SwitchKind) =>
  waitFor(() => expect(noteOf(kind)).toBeNull(), { timeout: A_LOADED_RUNNER_RENDER_MS });

describe('a switch request through A → B → A → B chains', () => {
  describe.each(SWITCH_KINDS)('the $kind switch', (kind) => {
    it('lands on A only, when its reply arrives on the second visit to B', async () => {
      // Arrange
      const reply = deferred<SwitchReply>();
      const { fixture, goTo } = await renderFleet(
        Object.assign(fakeApi(), { [kind.apiMethod]: vi.fn(() => reply.promise) }),
        [gimli(), legolas()],
      );
      await requestSwitch(kind);
      await goTo('s2');
      await goTo('s1');
      await goTo('s2');

      // Act
      reply.resolve({ status: 'deferred' });
      await settleRequests(fixture);

      // Assert — B shows nothing of A's request
      expect(noteOf(kind)).toBeNull();
      expect(errorOf(kind)).toBeNull();
      expect(applyButtonOf(kind)).toBeEnabled();
      await goTo('s1');
      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
      expect(applyButtonOf(kind)).toBeEnabled();
    });

    it('keeps A busy through A → B → A → B → A while the reply is pending, and sends nothing more', async () => {
      const reply = deferred<SwitchReply>();
      const api = Object.assign(fakeApi(), { [kind.apiMethod]: vi.fn(() => reply.promise) });
      const { goTo } = await renderFleet(api, [gimli(), legolas()]);
      await requestSwitch(kind);
      await goTo('s2');
      await goTo('s1');
      await goTo('s2');
      await goTo('s1');

      await userEvent.click(applyButtonOf(kind));

      expect(applyButtonOf(kind)).toBeDisabled();
      expect(api[kind.apiMethod]).toHaveBeenCalledTimes(1);
      reply.resolve({ status: 'deferred' });
    });

    it('gives B its own request while A\'s is pending, and A\'s reply then frees only A', async () => {
      const replyOfA = deferred<SwitchReply>();
      const replyOfB = deferred<SwitchReply>();
      const api = Object.assign(fakeApi(), {
        [kind.apiMethod]: vi.fn((sessionId: string) => (sessionId === 's1' ? replyOfA.promise : replyOfB.promise)),
      });
      const { fixture, goTo } = await renderFleet(api, [gimli(), legolas({ state: 'generating' })]);
      await requestSwitch(kind);
      await goTo('s2');
      await requestSwitch(kind);
      await goTo('s1');
      await goTo('s2');

      replyOfA.resolve({ status: 'deferred' });
      await settleRequests(fixture);
      expect(applyButtonOf(kind)).toBeDisabled();
      expect(noteOf(kind)).toBeNull();

      replyOfB.resolve({ status: 'deferred' });
      await settleRequests(fixture);
      expect(applyButtonOf(kind)).toBeEnabled();
      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
      await goTo('s1');
      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
    });
  });
});

describe('a permission-mode switch made from an inherited mode (no mode set)', () => {
  it('keeps its note across A → B → A, and clears it when the turn ends', async () => {
    const { daemon, goTo } = await renderFleet(fakeApi(), [gimli({ permissionMode: undefined }), legolas()]);
    await requestSwitch(permissionModeSwitch);
    await waitFor(() => expect(noteOf(permissionModeSwitch)).toHaveTextContent(SWITCH_PENDING_NOTE));

    await goTo('s2');
    await goTo('s1');
    expect(noteOf(permissionModeSwitch)).toHaveTextContent(SWITCH_PENDING_NOTE);

    await daemon.setState('s1', 'idle');
    await noteLeaves(permissionModeSwitch);
  });
});

describe('a switch request that fails while the user is on B, then a retry on A', () => {
  describe.each(SWITCH_KINDS)('the $kind switch', (kind) => {
    async function renderWithAFailingThenAnAnsweredRequest() {
      const firstReply = deferred<SwitchReply>();
      const secondReply = deferred<SwitchReply>();
      const replies = [firstReply, secondReply];
      const api = Object.assign(fakeApi(), { [kind.apiMethod]: vi.fn(() => replies.shift()!.promise) });
      const fleet = await renderFleet(api, [gimli(), legolas()]);
      await requestSwitch(kind);
      await fleet.goTo('s2');
      firstReply.reject(new Error('boom'));
      await settleRequests(fleet.fixture);
      return { ...fleet, api, secondReply };
    }

    it('shows nothing on B for A\'s failure', async () => {
      await renderWithAFailingThenAnAnsweredRequest();

      expect(errorOf(kind)).toBeNull();
      expect(noteOf(kind)).toBeNull();
      expect(applyButtonOf(kind)).toBeEnabled();
    });

    it('leaves A free to retry: back on A the select shows the value in force again, the request is sent again and its answer shows the note', async () => {
      const { fixture, goTo, api, secondReply } = await renderWithAFailingThenAnAnsweredRequest();
      await goTo('s1');
      expect(noteOf(kind)).toBeNull();
      expect(applyButtonOf(kind)).toBeEnabled();
      expect((screen.getByTestId(kind.select) as HTMLSelectElement).value).toBe(kind.valueInForce);

      await requestSwitch(kind);
      secondReply.resolve({ status: 'deferred' });
      await settleRequests(fixture);

      expect(api[kind.apiMethod]).toHaveBeenCalledTimes(2);
      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
      expect(errorOf(kind)).toBeNull();
    });

    it('tells the user on return to A that the switch failed while they were away', async () => {
      const { goTo } = await renderWithAFailingThenAnAnsweredRequest();

      await goTo('s1');

      expect(errorOf(kind)).toHaveTextContent(/could not/i);
    });
  });
});

describe('a failure that outlives what it was about', () => {
  describe.each(SWITCH_KINDS)('the failed $kind switch', (kind) => {
    const daemonReportsAnotherValue = (): ServerEvent =>
      kind.kind === 'model'
        ? { type: 'session.model_changed', sessionId: 's1', model: 'claude-opus-5-5' }
        : { type: 'session.permission_mode_changed', sessionId: 's1', mode: 'plan' };

    async function renderWithAFailureThatLandedWhileTheUserWasOnB() {
      const reply = deferred<SwitchReply>();
      const fleet = await renderFleet(
        Object.assign(fakeApi(), { [kind.apiMethod]: vi.fn(() => reply.promise) }),
        [gimli(), legolas()],
      );
      await requestSwitch(kind);
      await fleet.goTo('s2');
      reply.reject(new Error('boom'));
      await settleRequests(fleet.fixture);
      return fleet;
    }

    it('is no longer shown on return once the daemon reported another value for that session meanwhile', async () => {
      const { daemon, goTo } = await renderWithAFailureThatLandedWhileTheUserWasOnB();
      await daemon.send(daemonReportsAnotherValue());

      await goTo('s1');

      expect(errorOf(kind)).toBeNull();
    });

    it('is no longer shown on return once the session closed meanwhile', async () => {
      const { daemon, goTo } = await renderWithAFailureThatLandedWhileTheUserWasOnB();
      await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

      await goTo('s1');

      expect(errorOf(kind)).toBeNull();
    });
  });

  it('drops a resume failure that lands after the session lives again, even with the view gone, so a later clean close shows no "Resume failed"', async () => {
    // Arrange — the reopen reply is slow: the session is idle again, and the user elsewhere, before it fails
    const reopen = deferred<unknown>();
    const api = Object.assign(fakeApi(), { reopenSession: vi.fn(() => reopen.promise) });
    const { fixture, daemon, leaveTheSessionView, comeBackToTheSessionView } = await renderFleet(api, [
      gimli({ state: 'closed', exitCode: 0, closedAt: '2026-09-26T10:00:00.000Z' }),
    ]);
    await userEvent.click(screen.getByTestId('resume-session'));
    await leaveTheSessionView();
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });
    await daemon.setState('s1', 'idle');
    reopen.reject(new Error('network down'));
    await settleRequests(fixture);

    // Act — the user finishes elsewhere and the session closes cleanly, then the user returns
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });
    await comeBackToTheSessionView();

    // Assert
    expect(screen.queryByTestId('lifecycle-banner')).toBeNull();
  });
});

describe('two different request kinds on one session', () => {
  it('keeps the model request and the permission-mode request apart: one fails, the other still pending, then answered', async () => {
    // Arrange
    const modelReply = deferred<SwitchReply>();
    const permissionModeReply = deferred<SwitchReply>();
    const api = Object.assign(fakeApi(), {
      updateModel: vi.fn(() => modelReply.promise),
      updatePermissionMode: vi.fn(() => permissionModeReply.promise),
    });
    const { fixture, goTo } = await renderFleet(api, [gimli(), legolas()]);
    await requestSwitch(modelSwitch);
    await requestSwitch(permissionModeSwitch);
    await goTo('s2');
    await goTo('s1');

    // Act — the model request fails
    modelReply.reject(new Error('boom'));
    await settleRequests(fixture);

    // Assert
    expect(errorOf(modelSwitch)).toHaveTextContent(/could not switch model/i);
    expect(applyButtonOf(modelSwitch)).toBeEnabled();
    expect(applyButtonOf(permissionModeSwitch)).toBeDisabled();
    expect(errorOf(permissionModeSwitch)).toBeNull();

    permissionModeReply.resolve({ status: 'deferred' });
    await settleRequests(fixture);
    expect(noteOf(permissionModeSwitch)).toHaveTextContent(SWITCH_PENDING_NOTE);
    expect(noteOf(modelSwitch)).toBeNull();
    expect(errorOf(modelSwitch)).toHaveTextContent(/could not switch model/i);
  });

  it('shows no model note on a session that closed while its model request was in flight', async () => {
    // Arrange — the close goes through before the daemon's answer to the switch reaches the client
    const modelReply = deferred<SwitchReply>();
    const api = Object.assign(fakeApi(), { updateModel: vi.fn(() => modelReply.promise) });
    const { fixture, daemon } = await renderFleet(api, [gimli()]);
    await requestSwitch(modelSwitch);
    await requestClose();
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

    // Act
    modelReply.resolve({ status: 'deferred' });
    await settleRequests(fixture);

    // Assert
    expect(api.closeSession).toHaveBeenCalledTimes(1);
    expect(noteOf(modelSwitch)).toBeNull();
    expect(screen.getByTestId('session-closed-footer')).toBeTruthy();
  });

  it('closes a session with a pending model switch: the dialog warns, the note goes with the close, and a resume shows no old note', async () => {
    // Arrange
    const { daemon } = await renderFleet(fakeApi(), [gimli()]);
    await requestSwitch(modelSwitch);
    await waitFor(() => expect(noteOf(modelSwitch)).toHaveTextContent(SWITCH_PENDING_NOTE));

    // Act
    await userEvent.click(screen.getByTestId('session-close'));
    expect(screen.getByTestId('close-confirm-pending-switch')).toBeTruthy();
    await userEvent.click(screen.getByTestId('close-confirm-submit'));
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

    // Assert
    expect(noteOf(modelSwitch)).toBeNull();
    await userEvent.click(screen.getByTestId('resume-session'));
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't3' });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });
    await daemon.setState('s1', 'idle');
    expect(noteOf(modelSwitch)).toBeNull();
  });

  it('resume, then Close before the reopen reply: the reply lands on a closed session and leaves Resume usable', async () => {
    // Arrange
    const reopen = deferred<unknown>();
    const api = Object.assign(fakeApi(), { reopenSession: vi.fn(() => reopen.promise) });
    const { fixture, daemon } = await renderFleet(api, [gimli({ state: 'closed', exitCode: 0, closedAt: '2026-09-26T10:00:00.000Z' })]);
    await userEvent.click(screen.getByTestId('resume-session'));
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });
    await requestClose();
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

    // Act
    reopen.resolve({});
    await settleRequests(fixture);

    // Assert
    expect(screen.queryByTestId('lifecycle-banner')).toBeNull();
    expect(screen.getByTestId('resume-session')).toBeEnabled();
    expect(api.reopenSession).toHaveBeenCalledTimes(1);
    expect(api.closeSession).toHaveBeenCalledTimes(1);
  });
});

describe('Close and Interrupt of a session across A → B → A', () => {
  it('keeps Close and Interrupt of A disabled while A closes, and leaves B\'s buttons live', async () => {
    // Arrange
    const closeReply = deferred<unknown>();
    const api = Object.assign(fakeApi(), { closeSession: vi.fn(() => closeReply.promise) });
    const { goTo } = await renderFleet(api, [gimli(), legolas({ state: 'generating' })]);
    await requestClose();

    // Act / Assert
    await goTo('s2');
    expect(screen.getByTestId('session-close')).toBeEnabled();
    expect(screen.getByTestId('session-interrupt')).toBeEnabled();
    await goTo('s1');
    expect(screen.getByTestId('session-close')).toBeDisabled();
    expect(screen.getByTestId('session-interrupt')).toBeDisabled();
    closeReply.resolve({});
  });

  it('keeps A\'s failed close off B, and lets A close again on return', async () => {
    const closeReply = deferred<unknown>();
    const api = Object.assign(fakeApi(), { closeSession: vi.fn(() => closeReply.promise) });
    const { fixture, goTo } = await renderFleet(api, [gimli(), legolas()]);
    await requestClose();
    await goTo('s2');

    closeReply.reject(new Error('boom'));
    await settleRequests(fixture);

    expect(actionError()).toBeNull();
    expect(screen.getByTestId('session-close')).toBeEnabled();
    await goTo('s1');
    expect(screen.getByTestId('session-close')).toBeEnabled();
    await requestClose();
    expect(api.closeSession).toHaveBeenCalledTimes(2);
  });

  it('tells the user on return to A that the close failed while they were away', async () => {
    const closeReply = deferred<unknown>();
    const api = Object.assign(fakeApi(), { closeSession: vi.fn(() => closeReply.promise) });
    const { fixture, goTo } = await renderFleet(api, [gimli(), legolas()]);
    await requestClose();
    await goTo('s2');
    closeReply.reject(new Error('boom'));
    await settleRequests(fixture);

    await goTo('s1');

    expect(actionError()).toHaveTextContent(/could not close/i);
  });

  it('shows no interrupt error on a session that closed while its interrupt was still in flight', async () => {
    const interruptReply = deferred<unknown>();
    const api = Object.assign(fakeApi(), { sendInput: vi.fn(() => interruptReply.promise) });
    const { fixture, daemon } = await renderFleet(api, [gimli()]);
    await userEvent.click(screen.getByTestId('session-interrupt'));
    await requestClose();
    interruptReply.reject(new Error('boom'));
    await settleRequests(fixture);

    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

    expect(screen.getByTestId('session-closed-footer')).toBeTruthy();
    expect(actionError()).toBeNull();
  });
});

describe('a switch requested while the session is still starting', () => {
  describe.each(SWITCH_KINDS)('the $kind switch', (kind) => {
    it('keeps its note through the idle that ends the earlier launch and clears it once the queued relaunch has run', async () => {
      // Arrange — the daemon answers "deferred" to a switch made during 'starting'
      const { daemon } = await renderFleet(fakeApi(), [gimli({ state: 'starting' })]);
      await requestSwitch(kind);
      await waitFor(() => expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE));

      // Act / Assert — earlier launch over, queued relaunch not yet under way
      await daemon.setState('s1', 'idle');
      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
      await daemon.setState('s1', 'starting');
      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
      await daemon.setState('s1', 'idle');
      await noteLeaves(kind);
    });

    it('clears its note when the launch it waited on fails and the session closes', async () => {
      const { daemon } = await renderFleet(fakeApi(), [gimli({ state: 'starting' })]);
      await requestSwitch(kind);
      await waitFor(() => expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE));

      await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: -2 });

      await noteLeaves(kind);
    });

    it('clears its note through a launch that ends waiting for input, then a relaunch that ends idle', async () => {
      const { daemon } = await renderFleet(fakeApi(), [gimli({ state: 'starting' })]);
      await requestSwitch(kind);
      await waitFor(() => expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE));

      await daemon.setState('s1', 'waiting_input');
      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
      await daemon.setState('s1', 'starting');
      await daemon.setState('s1', 'waiting_input');

      await noteLeaves(kind);
    });

    it('keeps its note through the earlier launch when the user was on B, and an unrelated session event fired meanwhile', async () => {
      // Arrange
      const { daemon, goTo } = await renderFleet(fakeApi(), [gimli({ state: 'starting' }), legolas()]);
      await requestSwitch(kind);
      await waitFor(() => expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE));
      await goTo('s2');

      // Act — another session's traffic while A is still starting, then the earlier launch ends
      await daemon.setState('s2', 'generating');
      await daemon.setState('s1', 'idle');
      await goTo('s1');

      // Assert — the queued relaunch has not run
      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
      await daemon.setState('s1', 'starting');
      await daemon.setState('s1', 'idle');
      await noteLeaves(kind);
    });
  });

  it('clears both notes with the one relaunch the daemon runs for a model and a permission-mode switch', async () => {
    const { daemon } = await renderFleet(fakeApi(), [gimli({ state: 'starting' })]);
    await requestSwitch(modelSwitch);
    await requestSwitch(permissionModeSwitch);
    await waitFor(() => expect(noteOf(permissionModeSwitch)).toHaveTextContent(SWITCH_PENDING_NOTE));

    await daemon.setState('s1', 'idle');
    await daemon.setState('s1', 'starting');
    await daemon.setState('s1', 'idle');

    await noteLeaves(modelSwitch);
    await noteLeaves(permissionModeSwitch);
  });
});

describe('a relaunch the client never saw start', () => {
  // The notes follow the session's latest state, not the sequence of its states: a whole relaunch that lands before
  // one render (a throttled background window), or while the socket was down and a fresh snapshot replaced it,
  // reads as a plain 'idle'. The note then leaves on its own after a bounded time.
  const A_SLOW_RELAUNCH_MS = 10_000;
  const LONG_ENOUGH_FOR_ANY_RELAUNCH_MS = 60_000;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const relaunchNeverSeen = [
    {
      scenario: 'the whole relaunch lands before a render',
      arrive: (daemon: Daemon) =>
        daemon.sendInOneBurst(
          { type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' },
          { type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't3' },
        ),
    },
    {
      scenario: 'a reconnect snapshot shows the session idle again',
      arrive: (daemon: Daemon) => daemon.send({ type: 'snapshot', sessions: [gimli({ state: 'idle' })], approvals: [], managers: [] }),
    },
  ];

  describe.each(SWITCH_KINDS)('the $kind switch', (kind) => {
    it.each(relaunchNeverSeen)('drops its "restarting…" note within a minute when $scenario', async ({ arrive }) => {
      const { fixture, daemon } = await renderFleet(
        Object.assign(fakeApi(), { [kind.apiMethod]: vi.fn().mockResolvedValue({ status: 'relaunching' }) }),
        [gimli({ state: 'idle' })],
      );
      await requestSwitch(kind);
      await settleRequests(fixture);
      await arrive(daemon);

      vi.advanceTimersByTime(A_SLOW_RELAUNCH_MS);
      await fixture.whenStable();
      expect(noteOf(kind)).toHaveTextContent(RESTARTING_NOTE);

      vi.advanceTimersByTime(LONG_ENOUGH_FOR_ANY_RELAUNCH_MS);
      await fixture.whenStable();
      expect(noteOf(kind)).toBeNull();
    });
  });

  it('keeps a "switch pending" note through any wait: a turn can run for hours', async () => {
    const { fixture } = await renderFleet(fakeApi(), [gimli({ state: 'generating' })]);
    await requestSwitch(modelSwitch);
    await settleRequests(fixture);

    vi.advanceTimersByTime(60 * LONG_ENOUGH_FOR_ANY_RELAUNCH_MS);
    await fixture.whenStable();

    expect(noteOf(modelSwitch)).toHaveTextContent(SWITCH_PENDING_NOTE);
  });
});

describe('leaving the session view and coming back with a switch request in flight', () => {
  describe.each(SWITCH_KINDS)('the $kind switch', (kind) => {
    it('shows the "deferred" answer on return when the reply landed while the view was gone', async () => {
      const reply = deferred<SwitchReply>();
      const { fixture, leaveTheSessionView, comeBackToTheSessionView } = await renderFleet(
        Object.assign(fakeApi(), { [kind.apiMethod]: vi.fn(() => reply.promise) }),
        [gimli()],
      );
      await requestSwitch(kind);
      await leaveTheSessionView();

      reply.resolve({ status: 'deferred' });
      await settleRequests(fixture);
      await comeBackToTheSessionView();

      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
    });

    it('shows the "deferred" answer when the reply lands after the user is back, and keeps it through another leave and return', async () => {
      const reply = deferred<SwitchReply>();
      const { fixture, leaveTheSessionView, comeBackToTheSessionView } = await renderFleet(
        Object.assign(fakeApi(), { [kind.apiMethod]: vi.fn(() => reply.promise) }),
        [gimli()],
      );
      await requestSwitch(kind);
      await leaveTheSessionView();
      await comeBackToTheSessionView();

      reply.resolve({ status: 'deferred' });
      await settleRequests(fixture);

      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
      await leaveTheSessionView();
      await comeBackToTheSessionView();
      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
    });

    it('shows the failure and the value in force when the reply fails after the user is back', async () => {
      const reply = deferred<SwitchReply>();
      const { fixture, leaveTheSessionView, comeBackToTheSessionView } = await renderFleet(
        Object.assign(fakeApi(), { [kind.apiMethod]: vi.fn(() => reply.promise) }),
        [gimli()],
      );
      await requestSwitch(kind);
      await leaveTheSessionView();
      await comeBackToTheSessionView();

      reply.reject(new Error('boom'));
      await settleRequests(fixture);

      expect(errorOf(kind)).toHaveTextContent(/could not/i);
      expect(noteOf(kind)).toBeNull();
      expect(selectedValueOf(kind)).toBe(kind.valueInForce);
      expect(applyButtonOf(kind)).toBeEnabled();
    });

    it('keeps Apply disabled on return until the first reply lands, and sends no second request', async () => {
      const reply = deferred<SwitchReply>();
      const api = Object.assign(fakeApi(), { [kind.apiMethod]: vi.fn(() => reply.promise) });
      const { leaveTheSessionView, comeBackToTheSessionView } = await renderFleet(api, [gimli()]);
      await requestSwitch(kind);
      await leaveTheSessionView();
      await comeBackToTheSessionView();

      expect(applyButtonOf(kind)).toBeDisabled();
      await userEvent.click(applyButtonOf(kind));
      expect(api[kind.apiMethod]).toHaveBeenCalledTimes(1);
      reply.resolve({ status: 'deferred' });
    });
  });

  it('warns the Close dialog of a model switch whose "deferred" answer lands after the user is back', async () => {
    const reply = deferred<SwitchReply>();
    const api = Object.assign(fakeApi(), { updateModel: vi.fn(() => reply.promise) });
    const { fixture, leaveTheSessionView, comeBackToTheSessionView } = await renderFleet(api, [gimli()]);
    await requestSwitch(modelSwitch);
    await leaveTheSessionView();
    await comeBackToTheSessionView();
    reply.resolve({ status: 'deferred' });
    await settleRequests(fixture);

    await userEvent.click(screen.getByTestId('session-close'));

    expect(screen.getByTestId('close-confirm-pending-switch')).toBeTruthy();
  });

  it('keeps Close disabled on return until the first close reply lands', async () => {
    const closeReply = deferred<unknown>();
    const api = Object.assign(fakeApi(), { closeSession: vi.fn(() => closeReply.promise) });
    const { leaveTheSessionView, comeBackToTheSessionView } = await renderFleet(api, [gimli()]);
    await requestClose();
    await leaveTheSessionView();
    await comeBackToTheSessionView();

    expect(screen.getByTestId('session-close')).toBeDisabled();
    closeReply.resolve({});
  });
});
