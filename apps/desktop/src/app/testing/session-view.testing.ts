import { screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { Component, input, type DebugElement } from '@angular/core';
import type { TestBed } from '@angular/core/testing';
import { onTestFinished, vi } from 'vitest';
import type { ServerEvent } from '@openfleet/shared';
import { FleetEventsService } from '../core/fleet-events.service';
import { SessionViewComponent } from '../sessions/session-view.component';
import { TerminalComponent } from '../sessions/terminal.component';

interface Rendered {
  debugElement: DebugElement;
  whenStable(): Promise<unknown>;
}

@Component({ selector: 'of-terminal', template: '<div data-testid="terminal"></div>' })
class TerminalStubComponent {
  readonly sessionId = input.required<string>();
}

/** `render` option that swaps the xterm terminal for an empty stub: mounting a real one costs about 2 s per render. */
export const withoutRealTerminal = {
  configureTestBed: (testBed: TestBed) => {
    testBed.overrideComponent(SessionViewComponent, {
      remove: { imports: [TerminalComponent] },
      add: { imports: [TerminalStubComponent] },
    });
  },
};

export const RENDER_FRAME_MS = 20;

/**
 * Returns an `elapse(ms)` for a fixture under fake timers: it advances the clock by `ms`, then waits for the render.
 * A timer that fires on the very last millisecond schedules a render that only a further tick of the clock runs, so while
 * the render is pending the clock moves one render frame at a time instead of leaving `whenStable` waiting on a frozen clock.
 */
export function fakeClockElapser(fixture: Pick<Rendered, 'whenStable'>) {
  return async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    let isRendered = false;
    const rendered = fixture.whenStable().then(() => {
      isRendered = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    while (!isRendered) await vi.advanceTimersByTimeAsync(RENDER_FRAME_MS);
    await rendered;
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets what a settled request chains onto it run, then renders. */
export async function settleRequests(fixture: Pick<Rendered, 'whenStable'>) {
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

export const SWITCH_KINDS = [
  { kind: 'model', select: 'model-select', valueInForce: 'claude-sonnet-5', option: 'opus', apply: 'apply-model', note: 'model-switch-status', error: 'model-switch-error', apiMethod: 'updateModel' },
  { kind: 'permission-mode', select: 'permission-mode-select', valueInForce: 'manual', option: 'acceptEdits', apply: 'apply-permission-mode', note: 'permission-mode-switch-status', error: 'permission-mode-switch-error', apiMethod: 'updatePermissionMode' },
] as const;
export type SwitchKind = (typeof SWITCH_KINDS)[number];

export async function requestSwitch({ select, option, apply }: SwitchKind) {
  await userEvent.selectOptions(screen.getByTestId(select), option);
  await userEvent.click(screen.getByTestId(apply));
}

export const noteOf = ({ note }: SwitchKind) => screen.queryByTestId(note);
export const errorOf = ({ error }: SwitchKind) => screen.queryByTestId(error);
export const applyButtonOf = ({ apply }: SwitchKind) => screen.getByTestId(apply) as HTMLButtonElement;
export const selectedValueOf = ({ select }: SwitchKind) => (screen.getByTestId(select) as HTMLSelectElement).value;

class FakeWebSocket {
  static latest: FakeWebSocket | undefined;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  private readonly messageListeners: ((event: { data: string }) => void)[] = [];
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {
    FakeWebSocket.latest = this;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    if (type === 'message') this.messageListeners.push(listener);
  }

  send(): void {}

  dispatchMessage(payload: unknown): void {
    for (const listener of this.messageListeners) listener({ data: JSON.stringify(payload) });
  }
}

/** Connects the real FleetEventsService to a fake WebSocket, so a test feeds it the daemon's own events. */
export function connectFakeDaemon(fixture: Rendered) {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  fixture.debugElement.injector.get(FleetEventsService).connect();
  const socket = FakeWebSocket.latest!;
  return {
    async send(event: ServerEvent) {
      socket.dispatchMessage(event);
      await fixture.whenStable();
    },
    /** Events that reach the client before Angular renders in between. */
    async sendInOneBurst(...events: ServerEvent[]) {
      for (const event of events) socket.dispatchMessage(event);
      await fixture.whenStable();
    },
  };
}
