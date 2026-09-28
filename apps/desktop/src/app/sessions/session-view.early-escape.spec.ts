import { fireEvent, render, screen } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent, Session, SessionState } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { FleetApiService } from '../core/fleet-api.service';
import { connectFakeDaemon, fakeClockElapser, RENDER_FRAME_MS, withoutRealTerminal } from '../testing/session-view.testing';

const ESCAPE_KEY = '\x1b';
const COMPOSER_REDRAW_WITH_RESTORED_PROMPT = '\x1b[2K❯ hi';
const SPINNER_FRAME = '\x1b[2K✻ Thinking…';
const INTERRUPT_LINE = '⎿  Interrupted · What should Claude do instead?';
const SPINNER_TICK_MS = 100;

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli', emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'generating', stateSince: 't1', permissionMode: 'manual', createdAt: 't', ...patch,
  } as Session;
}

function fakeApi() {
  return {
    closeSession: vi.fn().mockResolvedValue({}),
    sendInput: vi.fn().mockResolvedValue({}),
  };
}

async function renderGeneratingSession(api = fakeApi()) {
  const { fixture } = await render(SessionViewComponent, {
    bindings: [inputBinding('sessionId', signal('s1'))],
    providers: [{ provide: FleetApiService, useValue: api }],
    ...withoutRealTerminal,
  });
  const daemon = connectFakeDaemon(fixture);
  await daemon.send({ type: 'snapshot', sessions: [session()], approvals: [], managers: [] });
  vi.useFakeTimers();
  const elapse = fakeClockElapser(fixture);
  const send = async (event: ServerEvent) => {
    await Promise.all([daemon.send(event), vi.advanceTimersByTimeAsync(RENDER_FRAME_MS)]);
  };
  const output = (data: string) => send({ type: 'session.output', sessionId: 's1', data });
  const changeState = (state: SessionState, stateSince: string) => send({ type: 'session.state', sessionId: 's1', state, stateSince });
  const pressInterrupt = async () => {
    fireEvent.click(screen.getByTestId('session-interrupt'));
    await elapse(0);
  };
  return { api, changeState, elapse, output, pressInterrupt };
}

const hint = () => screen.queryByTestId('early-escape-hint');

describe('SessionViewComponent early-escape hint — Claude cancels silently when Escape lands before the first reply', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('after Interrupt, the CLI redraws the composer with the restored prompt then falls silent: the hint tells the user to press Enter in the terminal', async () => {
    // Arrange
    const { api, output, pressInterrupt, elapse } = await renderGeneratingSession();

    // Act
    await pressInterrupt();
    await output(COMPOSER_REDRAW_WITH_RESTORED_PROMPT);
    await elapse(10_000);

    // Assert
    expect(api.sendInput).toHaveBeenCalledWith('s1', ESCAPE_KEY);
    expect(hint()).toHaveTextContent('Cancelled before a reply?');
    expect(hint()).toHaveTextContent('press Enter in the terminal to resend it, or edit it first');
  });

  it('a normal interrupted turn (interrupt line, then idle) never shows the hint', async () => {
    // Arrange
    const { changeState, pressInterrupt, output, elapse } = await renderGeneratingSession();

    // Act
    await pressInterrupt();
    await output(INTERRUPT_LINE);
    await changeState('idle', 't2');
    await elapse(60_000);

    // Assert
    expect(hint()).toBeNull();
  });

  it('a turn that keeps animating after the Escape (Escape ignored, spinner still running) never shows the hint', async () => {
    // Arrange
    const { pressInterrupt, output, elapse } = await renderGeneratingSession();
    await pressInterrupt();

    // Act
    for (let tick = 0; tick < 300; tick++) {
      await output(SPINNER_FRAME);
      await elapse(SPINNER_TICK_MS);
    }

    // Assert
    expect(hint()).toBeNull();
  });

  it('a generating session that is quiet without any Escape sent shows no hint', async () => {
    // Arrange
    const { output, elapse } = await renderGeneratingSession();

    // Act
    await output(SPINNER_FRAME);
    await elapse(60_000);

    // Assert
    expect(hint()).toBeNull();
  });

  it('the hint leaves when the state changes (the user resent the prompt, the turn ends)', async () => {
    // Arrange
    const { changeState, pressInterrupt, elapse } = await renderGeneratingSession();
    await pressInterrupt();
    await elapse(10_000);
    expect(hint()).not.toBeNull();

    // Act
    await changeState('idle', 't2');

    // Assert
    expect(hint()).toBeNull();
  });

  it('the hint leaves when the terminal comes alive again (the user pressed Enter, the CLI answers)', async () => {
    // Arrange
    const { pressInterrupt, output, elapse } = await renderGeneratingSession();
    await pressInterrupt();
    await elapse(10_000);
    expect(hint()).not.toBeNull();

    // Act
    await output(SPINNER_FRAME);

    // Assert
    expect(hint()).toBeNull();
  });

  it('a later generating turn is not blamed on an old Escape', async () => {
    // Arrange
    const { changeState, pressInterrupt, elapse } = await renderGeneratingSession();
    await pressInterrupt();
    await changeState('idle', 't2');
    await changeState('generating', 't3');

    // Act
    await elapse(60_000);

    // Assert
    expect(hint()).toBeNull();
  });
});
