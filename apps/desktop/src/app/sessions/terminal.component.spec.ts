import { render, waitFor } from '@testing-library/angular/zoneless';
import { inputBinding, signal, type WritableSignal } from '@angular/core';
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
  return { output, sendInput: vi.fn(), sendResize: vi.fn(), sendAttach: vi.fn(), sessions: signal([]), approvals: signal([]), connected: signal(true), reconnectCount: signal(0) };
}

describe('TerminalComponent', () => {
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
    const firstTerminal = fixture.componentInstance.terminal!;
    const firstWriteSpy = vi.spyOn(firstTerminal, 'write');

    sessionId.set('s2');
    await fixture.whenStable();
    sessionId.set('s3');
    await fixture.whenStable();
    const currentWriteSpy = vi.spyOn(fixture.componentInstance.terminal!, 'write');

    fake.output('s1').next('stale for s1');
    fake.output('s2').next('stale for s2');
    await fixture.whenStable();
    expect(firstWriteSpy).not.toHaveBeenCalled();

    fake.output('s3').next('current live');
    await fixture.whenStable();
    expect(currentWriteSpy).toHaveBeenCalledTimes(1);
    expect(currentWriteSpy).toHaveBeenCalledWith('current live');
  });

  it('clears the terminal and re-attaches to the current session on reconnect', async () => {
    const fake = fakeEventsService();
    const { fixture } = await render(TerminalComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetEventsService, useValue: fake }],
    });
    expect(fake.sendAttach).toHaveBeenCalledTimes(1);
    const clearSpy = vi.spyOn(fixture.componentInstance.terminal!, 'clear');

    fake.reconnectCount.set(1);
    await fixture.whenStable();

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(fake.sendAttach).toHaveBeenCalledTimes(2);
    expect(fake.sendAttach).toHaveBeenLastCalledWith('s1');
  });
});
