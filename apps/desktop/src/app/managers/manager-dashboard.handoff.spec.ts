import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, map } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { HandoffPreview } from '@openfleet/shared';
import { ManagerDashboardComponent } from './manager-dashboard.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

const MANAGER_SESSION = { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle', harness: 'claude-cli' };
const OTHER_MANAGER_SESSION = { ...MANAGER_SESSION, id: 'm2', name: 'Second' };
const MANAGER_VIEW = { sessionId: 'm1', pulseSeconds: 1800, childrenCap: 2, missionText: 'x', nextPulseAt: new Date(Date.now() + 42_000).toISOString(), childrenCount: 0 };

const UNAVAILABLE_TARGET = { available: false, reason: 'no_project', writeOnCloseDefault: false } as const;
const AVAILABLE_TARGET = { available: true, relativePath: 'handoffs/2026-10-04-lead.md', writeOnCloseDefault: true } as const;

function previewFor(sessionId: string, target: HandoffPreview['target'] = UNAVAILABLE_TARGET): HandoffPreview {
  return {
    sessionId,
    kind: 'manager',
    sections: { goal: `Mission of ${sessionId}`, state: '2 children', decisions: '', filesTouched: '', nextSteps: '', openQuestions: '' },
    sources: { goal: 'manager', state: 'manager', decisions: 'none', filesTouched: 'none', nextSteps: 'none', openQuestions: 'none' },
    truncated: [],
    target,
    generatedAt: '2026-10-04T10:00:00.000Z',
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((res) => (resolve = res));
  return { promise, resolve };
}

async function renderDashboard({ session = MANAGER_SESSION, getHandoffPreview = vi.fn((id: string) => Promise.resolve(previewFor(id))) } = {}) {
  const managerId = new BehaviorSubject('m1');
  const sessions = signal<unknown[]>([session, OTHER_MANAGER_SESSION]);
  await render(ManagerDashboardComponent, {
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { paramMap: managerId.pipe(map((id) => convertToParamMap({ id }))) } },
      { provide: FleetApiService, useValue: { pulseNow: vi.fn(), getHandoffPreview } },
      {
        provide: FleetEventsService,
        useValue: {
          sessions, approvals: signal([]), managers: signal([MANAGER_VIEW]), snapshotReceived: signal(true), workingStates: signal(new Map()),
          workingStatesReported: signal(false), workingStateMaxAgeMinutes: signal<number | undefined>(30), workingStateMaxBytes: signal<number | undefined>(6144),
        },
      },
    ],
  });
  return { getHandoffPreview, showManager: (id: string) => managerId.next(id) };
}

const writeHandoffButton = () => screen.getByRole('button', { name: 'Write handoff' });
const panel = () => screen.queryByRole('dialog', { name: 'Handoff preview' });

describe('ManagerDashboardComponent write handoff', () => {
  it('offers the Write handoff button on an open manager', async () => {
    await renderDashboard();

    expect(writeHandoffButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('offers the Write handoff button on a closed manager', async () => {
    await renderDashboard({ session: { ...MANAGER_SESSION, state: 'closed' } });

    expect(writeHandoffButton()).toBeTruthy();
  });

  it('asks the daemon for nothing, and shows no panel, until the button is pressed', async () => {
    const { getHandoffPreview } = await renderDashboard();

    expect(getHandoffPreview).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  it('shows the collecting state, then the sections of the manager, in the roomy layout', async () => {
    const pending = deferred<HandoffPreview>();
    const { getHandoffPreview } = await renderDashboard({ getHandoffPreview: vi.fn(() => pending.promise) });

    await userEvent.click(writeHandoffButton());
    expect(await screen.findByText('Collecting the state…')).toBeTruthy();
    pending.resolve(previewFor('m1'));

    expect(await screen.findByRole('textbox', { name: /Goal/ })).toHaveValue('Mission of m1');
    expect(getHandoffPreview).toHaveBeenCalledWith('m1');
    expect(document.querySelector('[data-density]')).toHaveAttribute('data-density', 'roomy');
  });

  it('asks what this manager was for in the Goal placeholder', async () => {
    await renderDashboard();

    await userEvent.click(writeHandoffButton());

    expect(await screen.findByRole('textbox', { name: /Goal/ })).toHaveAttribute('placeholder', 'What this manager was for');
  });

  it('tells where the draft comes from, without claiming the conversation was read', async () => {
    await renderDashboard();

    await userEvent.click(writeHandoffButton());

    expect(await screen.findByText('From the state panel and git status · edit before saving')).toBeTruthy();
  });

  it('keeps Save off with the reason and shows no saved-handoffs hint when there is no docs folder', async () => {
    await renderDashboard();

    await userEvent.click(writeHandoffButton());

    await screen.findByRole('textbox', { name: /Goal/ });
    const save = screen.getByRole('button', { name: 'Save handoff' });
    expect(save).toHaveAccessibleDescription('Save is off: this project has no docs folder yet.');
    expect(screen.queryByText(/Saved handoffs appear in Notes/)).toBeNull();
  });

  it('tells where saved handoffs appear when the target is usable', async () => {
    await renderDashboard({ getHandoffPreview: vi.fn((id: string) => Promise.resolve(previewFor(id, AVAILABLE_TARGET))) });

    await userEvent.click(writeHandoffButton());

    expect(await screen.findByText('Saved handoffs appear in Notes › handoffs and in the New-session picker.')).toBeTruthy();
  });

  it('shows the words of the error table when the preview cannot be collected', async () => {
    const envelope = { error: 'session_not_found', kind: 'not_found', retry: 'never', message: 'raw' };
    await renderDashboard({ getHandoffPreview: vi.fn(() => Promise.reject(new ApiError(404, 'GET /x', 'session_not_found', envelope as never))) });

    await userEvent.click(writeHandoffButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('That session no longer exists.');
    expect(screen.queryByText(/Saved handoffs appear in Notes/)).toBeNull();
  });

  it('closes the panel and gives focus back to the button on Escape', async () => {
    await renderDashboard();
    await userEvent.click(writeHandoffButton());
    await screen.findByRole('textbox', { name: /Goal/ });

    await userEvent.keyboard('{Escape}');

    await vi.waitFor(() => expect(panel()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(writeHandoffButton()));
  });

  it('drops the open panel when another manager is shown, and never opens it by itself', async () => {
    const { getHandoffPreview, showManager } = await renderDashboard();
    await userEvent.click(writeHandoffButton());
    await screen.findByRole('textbox', { name: /Goal/ });

    showManager('m2');

    await vi.waitFor(() => expect(panel()).toBeNull());
    expect(screen.queryByDisplayValue('Mission of m1')).toBeNull();
    expect(getHandoffPreview).toHaveBeenCalledTimes(1);
  });
});
