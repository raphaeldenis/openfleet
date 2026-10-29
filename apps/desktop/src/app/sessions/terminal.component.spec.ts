import { render, waitFor } from '@testing-library/angular/zoneless';
import { inputBinding, signal, type WritableSignal } from '@angular/core';
import type { Terminal } from '@xterm/xterm';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TerminalComponent } from './terminal.component';
import { FleetEventsService } from '../core/fleet-events.service';

function fakeEventsService() {
  const subjects = new Map<string, Subject<string>>();
  const output = (sessionId: string) => {
    const existing = subjects.get(sessionId);
    if (existing) return existing;
    const subject = new Subject<string>();
    subjects.set(sessionId, subject);
    return subject;
  };
  return {
    output,
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    sendAttach: vi.fn(),
    dropQueuedSendsFor: vi.fn(),
    sessions: signal([]),
    approvals: signal([]),
    connected: signal(true),
    reconnectCount: signal(0),
  };
}

const visibleText = (terminal: Terminal): string => {
  const lines = Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '');
  return lines.join('\n').trim();
};

describe('TerminalComponent', () => {
  it('shrinks instead of claiming its full flex height, so a sibling like the permission gate card stays visible', async () => {
    // Structure/CSS-only: this asserts the host's own flex sizing (a real layout regression — the
    // gate card pushed below the viewport in waiting_permission — is only visible in a browser).
    const fake = fakeEventsService();
    const { fixture } = await render(TerminalComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetEventsService, useValue: fake }],
    });
    expect(fixture.nativeElement).toHaveStyle({ flex: '1 1 auto', minHeight: '0' });
  });


  it('forwards typed keys to the session and writes replay then live output in order, over one channel', async () => {
    const fake = fakeEventsService();
    const { fixture } = await render(TerminalComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetEventsService, useValue: fake }],
    });
    const component = fixture.componentInstance;
    expect(fake.sendAttach).toHaveBeenCalledWith('s1');

    component.terminal!.input('y');
    expect(fake.sendInput).toHaveBeenCalledWith('s1', 'y');

    fake.output('s1').next('replayed ');
    fake.output('s1').next('live');
    await waitFor(() => {
      expect(component.terminal!.buffer.active.getLine(0)?.translateToString(true)).toContain('replayed live');
    });
  });

  it('subscribes before sending attach, so a reply arriving immediately is never missed', async () => {
    const fake = fakeEventsService();
    let subscriberPresentWhenAttachSent = false;
    fake.sendAttach = vi.fn((sessionId: string) => {
      subscriberPresentWhenAttachSent = fake.output(sessionId).observed;
    });
    await render(TerminalComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetEventsService, useValue: fake }],
    });
    expect(subscriberPresentWhenAttachSent).toBe(true);
  });

  it('switching sessions twice fast leaves exactly one live subscription and writes nothing to a disposed terminal', async () => {
    const fake = fakeEventsService();
    const sessionId: WritableSignal<string> = signal('s1');
    const { fixture } = await render(TerminalComponent, {
      bindings: [inputBinding('sessionId', sessionId)],
      providers: [{ provide: FleetEventsService, useValue: fake }],
    });

    sessionId.set('s2');
    await fixture.whenStable();
    sessionId.set('s3');
    await fixture.whenStable();

    fake.output('s1').next('stale for s1');
    fake.output('s2').next('stale for s2');
    fake.output('s3').next('current live');

    await waitFor(() => {
      expect(visibleText(fixture.componentInstance.terminal!)).toBe('current live');
    });
    expect(fake.output('s1').observed).toBe(false);
    expect(fake.output('s2').observed).toBe(false);
    expect(fake.output('s3').observed).toBe(true);
  });

  it('clears the terminal and re-attaches to the current session on reconnect', async () => {
    const fake = fakeEventsService();
    const { fixture } = await render(TerminalComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetEventsService, useValue: fake }],
    });
    expect(fake.sendAttach).toHaveBeenCalledTimes(1);
    fake.output('s1').next('stale before the drop\r\n'); // xterm's clear() keeps the cursor line, so the text sits on the line above it
    await waitFor(() => {
      expect(visibleText(fixture.componentInstance.terminal!)).toBe('stale before the drop');
    });

    fake.reconnectCount.set(1);
    await fixture.whenStable();

    await waitFor(() => {
      expect(visibleText(fixture.componentInstance.terminal!)).toBe('');
    });
    expect(fake.sendAttach).toHaveBeenCalledTimes(2);
    expect(fake.sendAttach).toHaveBeenLastCalledWith('s1');
  });
});
