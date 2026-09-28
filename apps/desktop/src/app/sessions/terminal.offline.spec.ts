import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { TerminalComponent } from './terminal.component';
import { connectFakeDaemon } from '../testing/session-view.testing';

/**
 * AUD-14 — a real terminal (xterm, not the stub) fed by the real FleetEventsService and a fake daemon
 * socket: keystrokes typed while the connection is down must never leave the client, even once it
 * reconnects, and the terminal must show itself read-only for as long as it is down.
 */

async function renderTerminal(options: { openImmediately?: boolean } = {}) {
  const { fixture } = await render(TerminalComponent, { bindings: [inputBinding('sessionId', () => 's1')] });
  const daemon = connectFakeDaemon(fixture, options);
  // A signal write (connected, on open) does not itself repaint in zoneless mode — the render only
  // catches up once something awaits stability, so every test starts from a settled DOM.
  await fixture.whenStable();
  return { fixture, daemon };
}

async function renderSwitchableTerminal() {
  const sessionId = signal('s1');
  const { fixture } = await render(TerminalComponent, { bindings: [inputBinding('sessionId', sessionId)] });
  const daemon = connectFakeDaemon(fixture);
  await fixture.whenStable();
  return { fixture, daemon, sessionId };
}

function sentTypes(daemon: Awaited<ReturnType<typeof renderTerminal>>['daemon']) {
  return daemon.sentMessages().map((message) => (message as { type: string }).type);
}

function attachedSessionIds(daemon: Awaited<ReturnType<typeof renderTerminal>>['daemon']) {
  return daemon
    .sentMessages()
    .filter((message) => (message as { type: string }).type === 'attach')
    .map((message) => (message as { sessionId: string }).sessionId);
}

describe('TerminalComponent offline (AUD-14)', () => {
  it('shows read-only the instant the connection drops, and writable again once it is back', async () => {
    const { fixture, daemon } = await renderTerminal();
    expect(screen.queryByTestId('terminal-readonly')).toBeNull();

    await daemon.disconnect();
    expect(screen.getByTestId('terminal-readonly')).toBeTruthy();

    await daemon.reconnect();
    await fixture.whenStable();
    expect(screen.queryByTestId('terminal-readonly')).toBeNull();
  });

  it('never sends a keystroke typed while disconnected, even after the socket reconnects', async () => {
    const { fixture, daemon } = await renderTerminal();
    await daemon.disconnect();

    fixture.componentInstance.terminal!.input('y');
    await fixture.whenStable();
    expect(sentTypes(daemon)).not.toContain('input');

    await daemon.reconnect();
    await fixture.whenStable();

    expect(sentTypes(daemon)).not.toContain('input');
  });

  it('sends an attach requested while the socket is still connecting exactly once, right after it opens', async () => {
    const { daemon } = await renderTerminal({ openImmediately: false });
    // TerminalComponent already asked to attach on mount, while the socket was CONNECTING.
    expect(sentTypes(daemon)).not.toContain('attach');

    await daemon.reconnect(); // fires the socket's open event

    expect(sentTypes(daemon).filter((type) => type === 'attach')).toHaveLength(1);
  });

  it('sends a keystroke typed while connected, through the real terminal instance', async () => {
    const { fixture, daemon } = await renderTerminal();

    fixture.componentInstance.terminal!.input('y');
    await fixture.whenStable();

    expect(sentTypes(daemon)).toContain('input');
  });

  it('attaches the session viewed at reconnect exactly once, even after switching away from another session while offline', async () => {
    const { fixture, daemon, sessionId } = await renderSwitchableTerminal();

    await daemon.disconnect();
    sessionId.set('s2');
    await fixture.whenStable();

    await daemon.reconnect();
    await fixture.whenStable();

    expect(attachedSessionIds(daemon)).toEqual(['s1', 's2']);
  });

  it('drops the queued attach of a session left before reconnecting, sending only the session still viewed', async () => {
    const { fixture, daemon, sessionId } = await renderSwitchableTerminal();

    await daemon.disconnect();
    sessionId.set('s2');
    await fixture.whenStable();
    sessionId.set('s3');
    await fixture.whenStable();

    await daemon.reconnect();
    await fixture.whenStable();

    expect(attachedSessionIds(daemon)).toEqual(['s1', 's3']);
  });
});
