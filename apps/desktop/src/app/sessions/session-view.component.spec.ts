import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { Approval, Session } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli', emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'idle', stateSince: 't', permissionMode: 'manual', createdAt: 't', ...patch,
  } as Session;
}

function approval(patch: Partial<Approval> = {}): Approval {
  return { id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' }, status: 'pending', createdAt: 't', ...patch };
}

function fakeEvents(sessions: Session[], approvals: Approval[] = []) {
  return {
    sessions: signal(sessions), approvals: signal(approvals), managers: signal([]),
    connected: signal(true), reconnectCount: signal(0), deliveredMessageIds: signal(new Set<string>()),
    output: () => new Subject<string>(), sendInput: vi.fn(), sendResize: vi.fn(), sendAttach: vi.fn(),
  };
}

function fakeApi() {
  return {
    updateModel: vi.fn().mockResolvedValue({ status: 'deferred' }),
    decide: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue({ status: 'delivered', messageId: 'm1' }),
  };
}

describe('SessionViewComponent', () => {
  it('renders the header and terminal for an open session', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session()]) }],
    });
    expect(screen.getByTestId('session-header')).toBeTruthy();
    expect(screen.getByTestId('terminal')).toBeTruthy();
  });

  it('renders the permission gate card inline while waiting on a permission', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [
        { provide: FleetApiService, useValue: fakeApi() },
        { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'waiting_permission' })], [approval()]) },
      ],
    });
    expect(screen.getByTestId('permission-gate-card')).toBeTruthy();
  });

  it('replaces the composer with a done banner and a disabled Resume action when the session closed cleanly', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 0 })]) }],
    });
    expect(screen.getByTestId('banner')).toHaveAttribute('data-variant', 'done');
    expect(screen.queryByTestId('composer-input')).toBeNull();
    const resume = screen.getByTestId('resume-session') as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
  });

  it('shows an error banner when the session closed with a non-zero exit code', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 1 })]) }],
    });
    expect(screen.getByTestId('banner')).toHaveAttribute('data-variant', 'error');
  });

  it('agrees with the header about an undefined exit code instead of showing it as both a clean and a failed close', async () => {
    // Arrange — an undefined exitCode is neither known-clean nor known-failed, so the header
    // (session-header.component.ts) shows a bare "closed" and the banner must not call it an error.
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: undefined })]) }],
    });

    // Assert — neither a clean nor a failed close: the header shows no exit number, the banner stays non-error
    expect(screen.getByTestId('session-exit-code')).toHaveTextContent('closed');
    expect(screen.getByTestId('session-exit-code')).not.toHaveTextContent('exit');
    expect(screen.getByTestId('banner')).toHaveAttribute('data-variant', 'done');
  });

  it('shows the composer for an open, non-gated session', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session()]) }],
    });
    expect(screen.getByTestId('composer-input')).toBeTruthy();
  });

  it('shows a not-found message when the session id matches nothing in the snapshot', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 'missing')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session()]) }],
    });
    expect(screen.getByTestId('session-view-not-found')).toBeTruthy();
  });
});
