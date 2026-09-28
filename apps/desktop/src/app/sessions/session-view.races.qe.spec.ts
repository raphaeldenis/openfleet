import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { ServerEvent, Session, SessionState } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

/** A test that states the wanted behavior of a known defect: it passes while the defect exists, and fails once the defect is fixed. */
const itShowsADefect = it.fails;

/**
 * QE (P2-U2e) — the session view as a user meets it: the real header, selectors and actions, fed the
 * daemon's own events by the real FleetEventsService reducer, with REST replies the test settles by hand.
 * Every assertion is on what is on screen or which request left the client.
 */

type SwitchReply = { status: 'relaunching' | 'deferred' };

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli', emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'generating', stateSince: 't', permissionMode: 'manual', createdAt: 't', ...patch,
  } as Session;
}

const gimli = (patch: Partial<Session> = {}) => session({ id: 's1', name: 'Gimli', ...patch });
const legolas = (patch: Partial<Session> = {}) => session({ id: 's2', name: 'Legolas', state: 'idle', ...patch });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

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
  const { fixture } = await render(ViewHostComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
  const host = fixture.componentInstance;
  const reducer = fixture.debugElement.injector.get(FleetEventsService) as unknown as { reduce(event: ServerEvent): void };
  const daemon = {
    async send(event: ServerEvent) {
      reducer.reduce(event);
      await fixture.whenStable();
    },
    /** Events that reach the client before Angular renders in between. */
    async sendInOneBurst(...events: ServerEvent[]) {
      for (const event of events) reducer.reduce(event);
      await fixture.whenStable();
    },
    setState: (sessionId: string, state: SessionState) => daemon.send({ type: 'session.state', sessionId, state, stateSince: 't2' }),
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

const PROMISE_HOPS_OF_A_SETTLED_REQUEST = 10;

/** Runs the continuations chained on a settled request (action → runGuarded → caller), then renders. */
async function settleRequests(fixture: { whenStable(): Promise<unknown> }) {
  for (let hop = 0; hop < PROMISE_HOPS_OF_A_SETTLED_REQUEST; hop++) await Promise.resolve();
  await fixture.whenStable();
}

const SWITCH_KINDS = [
  { kind: 'model', select: 'model-select', valueInForce: 'claude-sonnet-5', option: 'opus', apply: 'apply-model', note: 'model-switch-status', error: 'model-switch-error', apiMethod: 'updateModel' },
  { kind: 'permission-mode', select: 'permission-mode-select', valueInForce: 'manual', option: 'acceptEdits', apply: 'apply-permission-mode', note: 'permission-mode-switch-status', error: 'permission-mode-switch-error', apiMethod: 'updatePermissionMode' },
] as const;
type SwitchKind = (typeof SWITCH_KINDS)[number];

async function requestSwitch({ select, option, apply }: SwitchKind) {
  await userEvent.selectOptions(screen.getByTestId(select), option);
  await userEvent.click(screen.getByTestId(apply));
}

const noteOf = ({ note }: SwitchKind) => screen.queryByTestId(note);
const errorOf = ({ error }: SwitchKind) => screen.queryByTestId(error);
const applyButtonOf = ({ apply }: SwitchKind) => screen.getByTestId(apply) as HTMLButtonElement;
const modelSwitch = SWITCH_KINDS[0];
const permissionModeSwitch = SWITCH_KINDS[1];

const SWITCH_PENDING_NOTE = 'switch pending';
const RESTARTING_NOTE = 'restarting…';

async function requestClose() {
  await userEvent.click(screen.getByTestId('session-close'));
  await userEvent.click(screen.getByTestId('close-confirm-submit'));
}

const actionError = () => screen.queryByTestId('session-action-error');

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
    expect(noteOf(permissionModeSwitch)).toBeNull();
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

  it('sends the close of A once, even when the confirm dialog is reopened after A → B → A', async () => {
    const closeReply = deferred<unknown>();
    const api = Object.assign(fakeApi(), { closeSession: vi.fn(() => closeReply.promise) });
    const { goTo } = await renderFleet(api, [gimli(), legolas()]);
    await requestClose();
    await goTo('s2');
    await goTo('s1');

    await userEvent.click(screen.getByTestId('session-close'));

    expect(api.closeSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('close-confirm-dialog')).toBeNull();
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
      expect(noteOf(kind)).toBeNull();
    });

    it('clears its note when the launch it waited on fails and the session closes', async () => {
      const { daemon } = await renderFleet(fakeApi(), [gimli({ state: 'starting' })]);
      await requestSwitch(kind);
      await waitFor(() => expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE));

      await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: -2 });

      expect(noteOf(kind)).toBeNull();
    });

    it('clears its note through a launch that ends waiting for input, then a relaunch that ends idle', async () => {
      const { daemon } = await renderFleet(fakeApi(), [gimli({ state: 'starting' })]);
      await requestSwitch(kind);
      await waitFor(() => expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE));

      await daemon.setState('s1', 'waiting_input');
      expect(noteOf(kind)).toHaveTextContent(SWITCH_PENDING_NOTE);
      await daemon.setState('s1', 'starting');
      await daemon.setState('s1', 'waiting_input');

      expect(noteOf(kind)).toBeNull();
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
      expect(noteOf(kind)).toBeNull();
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

    expect(noteOf(modelSwitch)).toBeNull();
    expect(noteOf(permissionModeSwitch)).toBeNull();
  });
});

describe('a relaunch whose state events reach the client in one burst', () => {
  // Documented limit: the notes watch the session's latest state, not the sequence of its states, and the fleet
  // events service exposes no launch counter to tell "idle" from "starting → idle". A whole relaunch that lands before
  // one render therefore reads as a plain 'idle' and the note stays until the session closes. Only reachable when
  // rendering is late (a throttled background window).
  itShowsADefect.each(SWITCH_KINDS)('clears the $kind note when the whole relaunch (starting → idle) lands before a render', async (kind) => {
    const { fixture, daemon } = await renderFleet(
      Object.assign(fakeApi(), { [kind.apiMethod]: vi.fn().mockResolvedValue({ status: 'relaunching' }) }),
      [gimli({ state: 'idle' })],
    );
    await requestSwitch(kind);
    await settleRequests(fixture);
    expect(noteOf(kind)).toHaveTextContent(RESTARTING_NOTE);

    await daemon.sendInOneBurst(
      { type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' },
      { type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't3' },
    );

    expect(noteOf(kind)).toBeNull();
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
