import { fireEvent, render, screen } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent, Session } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { FleetApiService } from '../core/fleet-api.service';
import { connectFakeDaemon, withoutRealTerminal } from '../testing/session-view.testing';

const ESCAPE_KEY = '\x1b';
const COMPOSER_REDRAW = '\x1b[2K❯ hi';
const SPINNER_FRAME = '\x1b[2K✻ Thinking…';
const KEYSTROKE_ECHO = 'x';
const RENDER_FRAME_MS = 20;
const QUIET_MS = 4000;
const GENEROUS_QUIET_MS = 10_000;

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
  const daemon = connectFakeDaemon(fixture);
  await daemon.send({ type: 'snapshot', sessions, approvals: [], managers: [] });
  vi.useFakeTimers();
  const elapse = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await fixture.whenStable();
  };
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
  return { api, fixture, elapse, output, pressInterrupt, replay, send, viewSession };
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

  it('output 3 s in restarts the whole 4 s wait', async () => {
    // Arrange
    const { pressInterrupt, output, elapse } = await renderViewing();
    await pressInterrupt();
    await elapse(3000);

    // Act
    await output(SPINNER_FRAME);
    await elapse(QUIET_MS - RENDER_FRAME_MS - 100);

    // Assert
    expect(hint()).toBeNull();
    await elapse(200);
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

  it('the user types a few characters then pauses: the terminal is quiet again, so the hint comes back (spec: any output restarts the wait)', async () => {
    // Arrange
    const { pressInterrupt, output, elapse } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);

    // Act
    await output(KEYSTROKE_ECHO);
    await elapse(QUIET_MS - RENDER_FRAME_MS - 100);
    const whileStillTyping = hint();
    await elapse(200);

    // Assert
    expect(whileStillTyping).toBeNull();
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

  it('coming back to Gimli remounts its terminal, whose replay counts as output: the hint blinks off and returns once the terminal is quiet again (spec)', async () => {
    // Arrange
    const { pressInterrupt, elapse, viewSession, replay } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    await viewSession('s2');
    await viewSession('s1');

    // Act
    await replay(COMPOSER_REDRAW);
    const rightAfterTheReplay = hint();
    await elapse(QUIET_MS);

    // Assert
    expect(rightAfterTheReplay).toBeNull();
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
    expect(screen.getByTestId('composer-input')).toBeTruthy();
    expect(hint()).toBeNull();
  });

  it('Gimli’s terminal answers while the user is on Boromir: no hint when they come back', async () => {
    // Arrange
    const { pressInterrupt, elapse, viewSession, output } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);
    await viewSession('s2');

    // Act
    await output(SPINNER_FRAME, 's1');
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
    expect(screen.getByTestId('composer-input')).toBeTruthy();
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
    expect(screen.getByTestId('composer-input')).toBeTruthy();
    expect(hint()).toBeNull();
  });

  it('the session is renamed while the hint shows: the hint stays', async () => {
    // Arrange
    const { pressInterrupt, elapse, send } = await renderViewing();
    await pressInterrupt();
    await elapse(GENEROUS_QUIET_MS);

    // Act
    await send({ type: 'session.updated', session: session({ name: 'Gimli the Renamed' }) });

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
    expect(screen.getByTestId('composer-input')).toBeTruthy();
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

  it('the terminal re-requests its replay after a reconnect: the replay takes the hint down, and it returns once the terminal is quiet again (spec: a replay counts as output)', async () => {
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
    expect(rightAfterTheReplay).toBeNull();
    expect(hint()).not.toBeNull();
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

describe('early-escape hint — accessibility and copy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // DEFECT (minor, a11y): session-view.component.ts:53-58 inserts the role="status" element together with its text, so a screen
  // reader that only announces changes inside a region already in the page stays silent. The always-present
  // `lifecycle-live-region` (U2c) is the place for it. Remove `.fails` once the hint is rendered inside a pre-existing live region.
  it.fails('announces itself through a live region that was already in the page before the hint appeared', async () => {
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
    expect(hint()).toHaveTextContent('Claude put your prompt back — press Enter in the terminal to resend it, or edit it first.');
  });
});
