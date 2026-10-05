import { fireEvent, render, screen, within } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent, Session } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { connectFakeDaemon, fakeClockElapser, RENDER_FRAME_MS, withoutRealTerminal } from '../testing/session-view.testing';

const ESCAPE_KEY = '\x1b';
const COMPOSER_REDRAW = '\x1b[2K❯ hi';
const SPINNER_FRAME = '\x1b[2K✻ Thinking…';
const KEYSTROKE_ECHO = 'x';
const QUIET_MS = 4000;
const GENEROUS_QUIET_MS = 10_000;
const REDRAW_BURST_EVENTS = 5;
const LIVE_TURN_EVENT_EVERY_MS = 300;
const LIVE_TURN_LONG_ENOUGH_MS = 1500;
const FOCUS_IN_REPORT = '\x1b[I';
const FOCUS_OUT_REPORT = '\x1b[O';
const DEVICE_ATTRIBUTES_REPLY = '\x1b[?1;2c';
const CURSOR_POSITION_REPLY = '\x1b[24;80R';
const OSC_COLOR_REPLY = '\x1b]11;rgb:0000/0000/0000\x1b\\';

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli', emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'generating', stateSince: 't1', permissionMode: 'manual', createdAt: 't', ...patch,
  } as Session;
}

const gimli = () => session();
const boromir = () => session({ id: 's2', name: 'Boromir', emoji: '🛡️' });

function fakeApi() {
  return { closeSession: vi.fn().mockResolvedValue({}), sendInput: vi.fn().mockResolvedValue({}) };
}

async function renderViewing({ api = fakeApi(), sessions = [gimli(), boromir()] } = {}) {
  const sessionId = signal('s1');
  const { fixture } = await render(SessionViewComponent, {
    bindings: [inputBinding('sessionId', sessionId)],
    providers: [{ provide: FleetApiService, useValue: api }],
    ...withoutRealTerminal,
  });
  const daemon = await connectFakeDaemon(fixture);
  await daemon.send({ type: 'snapshot', sessions, approvals: [], managers: [] });
  vi.useFakeTimers();
  const elapse = fakeClockElapser(fixture);
  const send = async (event: ServerEvent) => {
    await Promise.all([daemon.send(event), vi.advanceTimersByTimeAsync(RENDER_FRAME_MS)]);
  };
  const output = (data: string, id = 's1') => send({ type: 'session.output', sessionId: id, data });
  const replay = (data: string, id = 's1') => send({ type: 'session.replay', sessionId: id, data });
  const pressInterrupt = async () => {
    fireEvent.click(screen.getByTestId('session-interrupt'));
    await elapse(0);
  };
  const viewSession = async (id: string) => {
    sessionId.set(id);
    await elapse(RENDER_FRAME_MS);
  };
  const events = () => fixture.debugElement.injector.get(FleetEventsService);
  const typeInTerminal = async (keys: string) => {
    events().sendInput('s1', keys);
    await output(keys);
  };
  const terminalSends = async (data: string) => {
    events().sendInput('s1', data);
    await elapse(RENDER_FRAME_MS);
  };
  const resizeTerminal = async () => {
    events().sendResize('s1', 80, 20);
    await elapse(RENDER_FRAME_MS);
  };
  const redrawBurst = async () => {
    for (let frame = 0; frame < REDRAW_BURST_EVENTS; frame++) await output(COMPOSER_REDRAW);
  };
  const liveTurnFor = async (ms: number, id = 's1') => {
    for (let elapsed = 0; elapsed < ms; elapsed += LIVE_TURN_EVENT_EVERY_MS) {
      await output(SPINNER_FRAME, id);
      await elapse(LIVE_TURN_EVENT_EVERY_MS - RENDER_FRAME_MS);
    }
  };
  const dropConnection = async () => {
    await Promise.all([daemon.disconnect(), vi.advanceTimersByTimeAsync(RENDER_FRAME_MS)]);
  };
  const restoreConnection = async () => {
    await Promise.all([daemon.reconnect(), vi.advanceTimersByTimeAsync(RENDER_FRAME_MS)]);
  };
  return {
    api, fixture, elapse, dropConnection, liveTurnFor, output, pressInterrupt, redrawBurst, replay,
    resizeTerminal, restoreConnection, send, terminalSends, typeInTerminal, viewSession,
  };
}

const hint = () => screen.queryByTestId('early-escape-hint');
const viewedSessionName = () => (screen.getByTestId('session-name-input') as HTMLInputElement).value;

describe('early-escape hint — timing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('appears once the terminal has been quiet for exactly 4 s after the Escape, not a moment before', async () => {
    // Arrange
    const { pressInterrupt, elapse } = await renderViewing();
    await pressInterrupt();

    // Act
    await elapse(QUIET_MS - 1);
    const justBefore = hint();
    await elapse(1 + RENDER_FRAME_MS);

    // Assert
    expect(justBefore).toBeNull();
    expect(hint()).not.toBeNull();
  });

  it('appears when the clock stops on the very millisecond the 4 s are up', async () => {
    // Arrange
    const { pressInterrupt, elapse } = await renderViewing();
    await pressInterrupt();

    // Act
    await elapse(QUIET_MS);

    // Assert
    expect(hint()).not.toBeNull();
  });

  it('pressing Interrupt a second time 3 s after the first restarts the wait from the second Escape', async () => {
    // Arrange
    const { api, pressInterrupt, elapse } = await renderViewing();
    await pressInterrupt();
    await elapse(3000);
    await pressInterrupt();

    // Act
    await elapse(2000);

    // Assert
    expect(api.sendInput).toHaveBeenCalledTimes(2);
    expect(hint()).toBeNull();
    await elapse(2100);
    expect(hint()).not.toBeNull();
  });

  it('pressing Interrupt again while the hint shows takes it down until the terminal has been quiet again', async () => {
    // Arrange
    const { pressInterrupt, elapse } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).not.toBeNull();

    // Act
    await pressInterrupt();

    // Assert
    expect(hint()).toBeNull();
    await elapse(QUIET_MS + RENDER_FRAME_MS);
    expect(hint()).not.toBeNull();
  });

  it('a failed Interrupt shows its error and no hint; the retry that succeeds arms the hint', async () => {
    // Arrange
    const api = fakeApi();
    api.sendInput.mockRejectedValueOnce(new Error('network'));
    const { pressInterrupt, elapse } = await renderViewing({ api });
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    expect(screen.getByTestId('session-action-error')).toBeTruthy();
    expect(hint()).toBeNull();

    // Act
    await pressInterrupt();
    await elapse(QUIET_MS + RENDER_FRAME_MS);

    // Assert
    expect(screen.queryByTestId('session-action-error')).toBeNull();
    expect(hint()).not.toBeNull();
  });

  it('an Interrupt that succeeded and then failed on retry keeps the hint of the Escape that did land', async () => {
    // Arrange
    const api = fakeApi();
    const { pressInterrupt, elapse } = await renderViewing({ api });
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    api.sendInput.mockRejectedValueOnce(new Error('network'));

    // Act
    await pressInterrupt();

    // Assert
    expect(screen.getByTestId('session-action-error')).toBeTruthy();
    expect(hint()).not.toBeNull();
  });
});

describe('early-escape hint — what the user does after the Escape', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the user types in the terminal: the echo takes the hint down, and the turn that follows never brings it back', async () => {
    // Arrange
    const { pressInterrupt, output, elapse, send } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).not.toBeNull();

    // Act
    await output(KEYSTROKE_ECHO);
    for (let tick = 0; tick < 100; tick++) {
      await output(SPINNER_FRAME);
      await elapse(100);
    }
    const whileTheTurnRuns = hint();
    await send({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't2' });
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(whileTheTurnRuns).toBeNull();
    expect(hint()).toBeNull();
  });

  it('the user types a few characters while the hint shows, then pauses: the hint does not come back while they edit', async () => {
    // Arrange
    const { pressInterrupt, typeInTerminal, elapse } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).not.toBeNull();

    // Act
    await typeInTerminal(KEYSTROKE_ECHO);
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(hint()).toBeNull();
  });

  it('the user starts editing the restored prompt before the 4 s are up: the hint never shows', async () => {
    // Arrange
    const { pressInterrupt, typeInTerminal, elapse } = await renderViewing();
    await pressInterrupt();
    await elapse(2000);

    // Act
    await typeInTerminal(KEYSTROKE_ECHO);
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(hint()).toBeNull();
  });

  it('the user resent the prompt after the hint showed: 4 s of silence in the middle of the new turn shows no false hint', async () => {
    // Arrange
    const { pressInterrupt, liveTurnFor, elapse } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).not.toBeNull();

    // Act
    await liveTurnFor(LIVE_TURN_LONG_ENOUGH_MS);
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(hint()).toBeNull();
  });

  it('a second Interrupt after the hint went away arms the watch again', async () => {
    // Arrange
    const { pressInterrupt, liveTurnFor, elapse } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    await liveTurnFor(LIVE_TURN_LONG_ENOUGH_MS);
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).toBeNull();

    // Act
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(hint()).not.toBeNull();
  });
});

describe('early-escape hint — several sessions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an Escape on Gimli never shows the hint on Boromir, even though both are generating since the same instant', async () => {
    // Arrange
    const { api, pressInterrupt, elapse, viewSession } = await renderViewing();
    await pressInterrupt();

    // Act
    await viewSession('s2');
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(viewedSessionName()).toContain('Boromir');
    expect(api.sendInput).toHaveBeenCalledWith('s1', ESCAPE_KEY);
    expect(hint()).toBeNull();
  });

  it('an Escape on Boromir never shows the hint on Gimli', async () => {
    // Arrange
    const { api, pressInterrupt, elapse, viewSession } = await renderViewing();
    await viewSession('s2');
    await pressInterrupt();

    // Act
    await viewSession('s1');
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(viewedSessionName()).toContain('Gimli');
    expect(api.sendInput).toHaveBeenCalledWith('s2', ESCAPE_KEY);
    expect(hint()).toBeNull();
  });

  it('Gimli → Boromir → Gimli before the 4 s are up: the hint still shows on time on Gimli, and never on Boromir', async () => {
    // Arrange
    const { pressInterrupt, elapse, viewSession } = await renderViewing();
    await pressInterrupt();
    await viewSession('s2');
    await elapse(1000);

    // Act
    await viewSession('s1');
    await elapse(QUIET_MS - 1000 - 2 * RENDER_FRAME_MS - 100);
    const beforeTheWaitIsOver = hint();
    await elapse(200);

    // Assert
    expect(beforeTheWaitIsOver).toBeNull();
    expect(hint()).not.toBeNull();
    await viewSession('s2');
    expect(hint()).toBeNull();
  });

  it('Gimli → Boromir → Gimli while the hint shows: it is still there on return', async () => {
    // Arrange
    const { pressInterrupt, elapse, viewSession } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).not.toBeNull();

    // Act
    await viewSession('s2');
    const onBoromir = hint();
    await viewSession('s1');

    // Assert
    expect(onBoromir).toBeNull();
    expect(hint()).not.toBeNull();
  });

  it('Gimli’s turn ends while the user is on Boromir: no hint when they come back', async () => {
    // Arrange
    const { pressInterrupt, elapse, viewSession, send } = await renderViewing();
    await pressInterrupt();
    await viewSession('s2');
    await send({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't2' });

    // Act
    await elapse(GENEROUS_QUIET_MS);
    await viewSession('s1');

    // Assert
    expect(screen.getByTestId('terminal')).toBeTruthy();
    expect(hint()).toBeNull();
  });

  it('Gimli’s terminal answers while the user is on Boromir: no hint when they come back', async () => {
    // Arrange
    const { pressInterrupt, elapse, viewSession, liveTurnFor } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    await viewSession('s2');

    // Act
    await liveTurnFor(LIVE_TURN_LONG_ENOUGH_MS, 's1');
    await viewSession('s1');

    // Assert
    expect(hint()).toBeNull();
  });

  it('output on Boromir does not take down the hint on Gimli', async () => {
    // Arrange
    const { pressInterrupt, elapse, output } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).not.toBeNull();

    // Act
    await output(SPINNER_FRAME, 's2');

    // Assert
    expect(hint()).not.toBeNull();
  });

  it('the Interrupt request resolves after the user has moved to Boromir: the hint waits for Gimli and never shows on Boromir', async () => {
    // Arrange
    const api = fakeApi();
    let resolveEscape!: () => void;
    api.sendInput.mockReturnValueOnce(new Promise<void>((resolve) => (resolveEscape = resolve)));
    const { pressInterrupt, elapse, viewSession } = await renderViewing({ api });
    await pressInterrupt();
    await viewSession('s2');

    // Act
    resolveEscape();
    await elapse(GENEROUS_QUIET_MS);
    const onBoromir = hint();
    await viewSession('s1');

    // Assert
    expect(onBoromir).toBeNull();
    expect(hint()).not.toBeNull();
  });
});

describe('early-escape hint — the replay/live split', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a replay right after the Escape does not seed the live-output run: brief real output shortly after stays under a sustained turn, so the hint still shows on time', async () => {
    // Arrange
    const { pressInterrupt, elapse, replay, output } = await renderViewing();
    await pressInterrupt();

    // Act — a replay, then real output close enough behind it that counting the replay as live output would
    // already read as 1 s of gap-continuous output by the third event and disarm the watch early.
    await replay(COMPOSER_REDRAW);
    await elapse(380);
    await output(SPINNER_FRAME);
    await elapse(380);
    await output(SPINNER_FRAME);
    await elapse(180);
    await output(SPINNER_FRAME);
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(hint()).not.toBeNull();
  });
});

describe('early-escape hint — the session lives on around it', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the session closes before the 4 s are up: no hint, the closed footer instead, and none after it is resumed', async () => {
    // Arrange
    const { pressInterrupt, elapse, send } = await renderViewing();
    await pressInterrupt();
    await elapse(2000);

    // Act
    await send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(screen.getByTestId('session-closed-footer')).toBeTruthy();
    expect(hint()).toBeNull();
    await send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
    await send({ type: 'session.reopened', sessionId: 's1' });
    await send({ type: 'session.state', sessionId: 's1', state: 'generating', stateSince: 't3' });
    await elapse(GENEROUS_QUIET_MS);
    expect(screen.getByTestId('terminal')).toBeTruthy();
    expect(hint()).toBeNull();
  });

  it('the session closes while the hint shows: the hint goes with it', async () => {
    // Arrange
    const { pressInterrupt, elapse, send } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).not.toBeNull();

    // Act
    await send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

    // Assert
    expect(screen.getByTestId('session-closed-footer')).toBeTruthy();
    expect(hint()).toBeNull();
  });

  it('the session is resumed and generates again after the hint showed: the new turn is not blamed on the old Escape', async () => {
    // Arrange
    const { pressInterrupt, elapse, send } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    await send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });
    await send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
    await send({ type: 'session.reopened', sessionId: 's1' });

    // Act
    await send({ type: 'session.state', sessionId: 's1', state: 'generating', stateSince: 't3' });
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(screen.getByTestId('terminal')).toBeTruthy();
    expect(hint()).toBeNull();
  });

  it('the session is renamed while the hint shows: the hint stays', async () => {
    // Arrange
    const { pressInterrupt, elapse, send } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);

    // Act
    await send({ type: 'session.updated', session: session({ name: 'Gimli the Renamed' }) });
    await elapse(0);

    // Assert
    expect(viewedSessionName()).toContain('Gimli the Renamed');
    expect(hint()).not.toBeNull();
  });
});

describe('early-escape hint — reconnect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a reconnect snapshot that still has the session generating since the same instant keeps the hint', async () => {
    // Arrange
    const { pressInterrupt, elapse, send } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);

    // Act
    await send({ type: 'snapshot', sessions: [gimli(), boromir()], approvals: [], managers: [] });

    // Assert
    expect(hint()).not.toBeNull();
  });

  it('a reconnect snapshot that finds the turn ended while the client was away takes the hint down', async () => {
    // Arrange
    const { pressInterrupt, elapse, send } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);

    // Act
    await send({ type: 'snapshot', sessions: [session({ state: 'idle', stateSince: 't2' }), boromir()], approvals: [], managers: [] });

    // Assert
    expect(screen.getByTestId('terminal')).toBeTruthy();
    expect(hint()).toBeNull();
  });

  it('a reconnect snapshot that finds a newer generating turn takes the hint down', async () => {
    // Arrange
    const { pressInterrupt, elapse, send } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);

    // Act
    await send({ type: 'snapshot', sessions: [session({ stateSince: 't9' }), boromir()], approvals: [], managers: [] });
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(hint()).toBeNull();
  });

  it('the terminal re-requests its replay after a reconnect: the replay is not activity, the hint stays up without blinking', async () => {
    // Arrange
    const { pressInterrupt, elapse, send, replay } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    await send({ type: 'snapshot', sessions: [gimli(), boromir()], approvals: [], managers: [] });

    // Act
    await replay(COMPOSER_REDRAW);
    const rightAfterTheReplay = hint();
    await elapse(QUIET_MS);

    // Assert
    expect(rightAfterTheReplay).not.toBeNull();
    expect(hint()).not.toBeNull();
  });
});

describe('early-escape hint — daemon connectivity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never shows while the connection is down, even long past the normal 4 s wait, and shows 4 s after it reconnects', async () => {
    // Arrange
    const { pressInterrupt, elapse, dropConnection, restoreConnection } = await renderViewing();
    await pressInterrupt();
    await elapse(1000);

    // Act
    await dropConnection();
    await elapse(GENEROUS_QUIET_MS);
    const stillDownPastTheNormalWait = hint();

    // Assert
    expect(stillDownPastTheNormalWait).toBeNull();
    await restoreConnection();
    await elapse(QUIET_MS - 500);
    expect(hint()).toBeNull();
    await elapse(600);
    expect(hint()).not.toBeNull();
  });

  it('a reconnect that finds the turn already over does not show the hint', async () => {
    // Arrange
    const { pressInterrupt, elapse, dropConnection, restoreConnection, send } = await renderViewing();
    await pressInterrupt();
    await elapse(1000);
    await dropConnection();
    await elapse(GENEROUS_QUIET_MS);

    // Act
    await restoreConnection();
    await send({ type: 'snapshot', sessions: [session({ state: 'idle', stateSince: 't2' }), boromir()], approvals: [], managers: [] });
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(hint()).toBeNull();
  });
});

describe('early-escape hint — the view goes away', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the view is destroyed while armed: nothing throws, and a view mounted later shows the hint once the quiet is over', async () => {
    // Arrange
    const { fixture, pressInterrupt, elapse } = await renderViewing();
    await pressInterrupt();
    await elapse(1000);

    // Act
    fixture.destroy();
    await elapse(GENEROUS_QUIET_MS);
    const remounted = TestBed.createComponent(SessionViewComponent);
    remounted.componentRef.setInput('sessionId', 's1');
    remounted.detectChanges();
    await elapse(RENDER_FRAME_MS);

    // Assert
    expect(hint()).not.toBeNull();
  });

  it('the view is destroyed while the hint shows: a view mounted later shows it again straight away', async () => {
    // Arrange
    const { fixture, pressInterrupt, elapse } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    fixture.destroy();

    // Act
    const remounted = TestBed.createComponent(SessionViewComponent);
    remounted.componentRef.setInput('sessionId', 's1');
    remounted.detectChanges();
    await elapse(RENDER_FRAME_MS);

    // Assert
    expect(hint()).not.toBeNull();
  });
});

describe('early-escape hint — a blip from the terminal is not a turn', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the banner shrinks the terminal, the page resizes, the CLI redraws in one burst: the hint stays', async () => {
    // Arrange
    const { pressInterrupt, elapse, resizeTerminal, redrawBurst } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).not.toBeNull();

    // Act
    await resizeTerminal();
    await redrawBurst();

    // Assert
    expect(hint()).not.toBeNull();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).not.toBeNull();
  });

  it('coming back to the session remounts its terminal — replay, fit, resize, DA reply, redraw: the hint never blinks', async () => {
    // Arrange
    const { pressInterrupt, elapse, viewSession, replay, resizeTerminal, terminalSends, redrawBurst } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    await viewSession('s2');
    await viewSession('s1');

    // Act
    const seenAfterEachStep: (HTMLElement | null)[] = [hint()];
    for (const step of [() => replay(COMPOSER_REDRAW), resizeTerminal, () => terminalSends(DEVICE_ATTRIBUTES_REPLY), redrawBurst]) {
      await step();
      seenAfterEachStep.push(hint());
    }

    // Assert
    expect(seenAfterEachStep.every((seen) => seen !== null)).toBe(true);
  });

  it.each([
    ['a focus-in report', FOCUS_IN_REPORT],
    ['a focus-out report', FOCUS_OUT_REPORT],
    ['a device attributes reply', DEVICE_ATTRIBUTES_REPLY],
    ['a cursor position report', CURSOR_POSITION_REPLY],
    ['an OSC color reply', OSC_COLOR_REPLY],
    ['several replies in one write', `${DEVICE_ATTRIBUTES_REPLY}${FOCUS_IN_REPORT}${OSC_COLOR_REPLY}`],
  ])('%s that the terminal sends by itself is not typing: the hint stays', async (_name, terminalGeneratedInput) => {
    // Arrange
    const { pressInterrupt, elapse, terminalSends } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);

    // Act
    await terminalSends(terminalGeneratedInput);
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(hint()).not.toBeNull();
  });

  it('a focus-in report before the 4 s are up does not stop the hint from showing on time', async () => {
    // Arrange
    const { pressInterrupt, elapse, terminalSends } = await renderViewing();
    await pressInterrupt();
    await elapse(1000);

    // Act
    await terminalSends(FOCUS_IN_REPORT);
    await elapse(QUIET_MS - 1000);

    // Assert
    expect(hint()).not.toBeNull();
  });

  it.each([
    ['a printable key', 'x'],
    ['Enter', '\r'],
    ['Backspace', '\x7f'],
    ['an arrow key', '\x1b[A'],
    ['a key typed together with a focus-in report', `${FOCUS_IN_REPORT}x`],
  ])('%s is real typing: the hint goes away', async (_name, keys) => {
    // Arrange
    const { pressInterrupt, elapse, terminalSends } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).not.toBeNull();

    // Act
    await terminalSends(keys);

    // Assert
    expect(hint()).toBeNull();
  });

  it('a live turn (one output every 300 ms for 1.5 s) takes the hint down', async () => {
    // Arrange
    const { pressInterrupt, elapse, liveTurnFor } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).not.toBeNull();

    // Act
    await liveTurnFor(LIVE_TURN_LONG_ENOUGH_MS);

    // Assert
    expect(hint()).toBeNull();
    await elapse(GENEROUS_QUIET_MS);
    expect(hint()).toBeNull();
  });

  it('a live turn during the 4 s wait means the hint never shows', async () => {
    // Arrange
    const { pressInterrupt, elapse, liveTurnFor } = await renderViewing();
    await pressInterrupt();

    // Act
    await liveTurnFor(LIVE_TURN_LONG_ENOUGH_MS);
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(hint()).toBeNull();
  });

  it('a single output 3 s in does not restart the wait: one event is not a turn', async () => {
    // Arrange
    const { pressInterrupt, elapse, output } = await renderViewing();
    await pressInterrupt();
    await elapse(3000);

    // Act
    await output(SPINNER_FRAME);
    await elapse(QUIET_MS - 3000);

    // Assert
    expect(hint()).not.toBeNull();
  });

  it('an output every 2 s is not a live turn: the hint still shows on time', async () => {
    // Arrange
    const { pressInterrupt, elapse, output } = await renderViewing();
    await pressInterrupt();
    await elapse(1000);
    await output(SPINNER_FRAME);
    await elapse(2000);
    await output(SPINNER_FRAME);

    // Act
    await elapse(QUIET_MS);

    // Assert
    expect(hint()).not.toBeNull();
  });
});

describe('early-escape hint — accessibility and copy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces itself through a live region that was already in the page before the hint appeared', async () => {
    // Arrange
    const { pressInterrupt, elapse } = await renderViewing();
    const liveRegionsBeforeTheHint = [...document.querySelectorAll('[role="status"], [aria-live]')];

    // Act
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    const announcingRegions = liveRegionsBeforeTheHint.filter((region) => region.contains(hint()));
    expect(announcingRegions).not.toHaveLength(0);
  });

  it('says what happened and what to do: a question as title, then the action to take', async () => {
    // Arrange
    const { pressInterrupt, elapse } = await renderViewing();

    // Act
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    expect(hint()).toHaveTextContent('Cancelled before a reply?');
    expect(hint()).toHaveTextContent('Claude may have put your prompt back — press Enter in the terminal to resend it, or edit it first.');
  });

  it('keeps the arrow glyph out of the accessibility tree: a screen reader would read it as "leftwards arrow with hook"', async () => {
    // Arrange
    const { pressInterrupt, elapse } = await renderViewing();

    // Act
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);

    // Assert
    const glyph = within(hint()!).getByText('↩');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  });
});
