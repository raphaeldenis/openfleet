import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { InboxComponent } from './inbox.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function fakeEvents(approval: Record<string, unknown> = {}) {
  return {
    sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission' }]),
    approvals: signal([{ id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, status: 'pending', createdAt: 't', ...approval }]),
  };
}

describe('InboxComponent', () => {
  it('shows a pending gate as a card with the session label, tool name and formatted arguments, and sends the decision', async () => {
    // Arrange
    const api = { decide: vi.fn().mockResolvedValue({}) };
    // Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const card = screen.getByTestId('inbox-gate-card');
    // Assert
    expect(within(card).getByTestId('inbox-gate-session')).toHaveTextContent('⚔️ Gimli');
    expect(within(card).getByTestId('inbox-gate-tool')).toHaveTextContent('Bash');
    expect(within(card).getByTestId('inbox-gate-args')).toHaveTextContent('"command": "rm -rf dist"');
    await userEvent.click(within(card).getByTestId('inbox-allow'));
    expect(api.decide).toHaveBeenCalledWith('a1', 'allow');
  });

  it('denies a gate via the Deny button', async () => {
    // Arrange
    const api = { decide: vi.fn().mockResolvedValue({}) };
    // Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    await userEvent.click(screen.getByTestId('inbox-deny'));
    // Assert
    expect(api.decide).toHaveBeenCalledWith('a1', 'deny');
  });

  it('disables the buttons while the decision is in flight, and re-enables once it settles', async () => {
    // Arrange
    let resolveDecide: (value: unknown) => void = () => {};
    const api = { decide: vi.fn(() => new Promise((resolve) => { resolveDecide = resolve; })) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const allowButton = screen.getByTestId('inbox-allow') as HTMLButtonElement;

    // Act
    fireEvent.click(allowButton);
    await waitFor(() => expect(allowButton.disabled).toBe(true));
    resolveDecide({});

    // Assert
    await waitFor(() => expect(allowButton.disabled).toBe(false));
  });

  it('double-clicking Allow sends exactly one request', async () => {
    // Arrange
    const api = { decide: vi.fn(() => new Promise(() => {})) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const allowButton = screen.getByTestId('inbox-allow');

    // Act
    fireEvent.click(allowButton);
    fireEvent.click(allowButton);

    // Assert
    expect(api.decide).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error when the decision request fails', async () => {
    // Arrange
    const api = { decide: vi.fn().mockRejectedValue(new Error('network down')) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });

    // Act
    await userEvent.click(screen.getByTestId('inbox-allow'));

    // Assert
    expect(await screen.findByTestId('inbox-error')).toBeTruthy();
  });

  it('removes the item instead of erroring when the decision is already resolved (409)', async () => {
    // Arrange
    const api = { decide: vi.fn().mockRejectedValue(new ApiError(409, 'already_resolved')) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });

    // Act
    await userEvent.click(screen.getByTestId('inbox-allow'));

    // Assert
    await waitFor(() => expect(screen.queryByTestId('inbox-gate-card')).toBeNull());
  });

  it('renders the gate card with the KindBadge for kind "gate"', async () => {
    // Arrange & Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const card = screen.getByTestId('inbox-gate-card');

    // Assert
    expect(within(card).getByTestId('kind-badge')).toHaveTextContent('GATE');
  });

  it('keeps long tool arguments scrollable inside the card instead of growing it', async () => {
    // Arrange
    const longCommand = 'echo '.concat('x'.repeat(2000));
    // Act
    await render(InboxComponent, {
      providers: [
        { provide: FleetApiService, useValue: { decide: vi.fn() } },
        { provide: FleetEventsService, useValue: fakeEvents({ toolInput: { command: longCommand } }) },
      ],
    });

    // Assert
    expect(screen.getByTestId('inbox-gate-args')).toHaveStyle({ overflow: 'auto', whiteSpace: 'pre-wrap' });
  });

  it('shows the All filter enabled, and Unread/Mine/Blocked/Recent disabled with a "needs backend support" tooltip', async () => {
    // Arrange & Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });

    // Assert
    expect((screen.getByTestId('inbox-filter-all') as HTMLButtonElement).disabled).toBe(false);
    for (const key of ['unread', 'mine', 'blocked', 'recent']) {
      const button = screen.getByTestId(`inbox-filter-${key}`) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toMatch(/needs backend support/i);
    }
  });

  it('switching to the Questions tab shows the "coming" notice and renders zero fake items', async () => {
    // Arrange
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });

    // Act
    await userEvent.click(screen.getByTestId('inbox-tab-questions'));

    // Assert
    expect(screen.getByTestId('inbox-questions-coming')).toBeTruthy();
    expect(screen.queryByTestId('inbox-gate-card')).toBeNull();
  });

  it('switching to the Proposals tab shows the "coming" notice and renders zero fake items', async () => {
    // Arrange
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });

    // Act
    await userEvent.click(screen.getByTestId('inbox-tab-proposals'));

    // Assert
    expect(screen.getByTestId('inbox-proposals-coming')).toBeTruthy();
    expect(screen.queryByTestId('inbox-gate-card')).toBeNull();
  });

  it('shows an empty state and a zero count when there are no gates waiting', async () => {
    // Arrange
    const events = { sessions: signal([]), approvals: signal([]) };

    // Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: events }] });

    // Assert
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent('Nothing waiting for you.');
    expect(screen.getByTestId('inbox-count')).toHaveTextContent('0');
    expect(screen.queryByTestId('inbox-gate-card')).toBeNull();
  });

  it('shows a live age that advances as time passes, not a value frozen at render', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const createdAt = new Date(Date.now() - 5000).toISOString();
      const { fixture } = await render(InboxComponent, {
        providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents({ createdAt }) }],
      });
      const before = screen.getByTestId('inbox-gate-age').textContent;

      // Act
      await vi.advanceTimersByTimeAsync(3000);
      await fixture.whenStable();

      // Assert
      expect(screen.getByTestId('inbox-gate-age').textContent).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up its 1s age ticker on destroy, leaving no dangling timer', async () => {
    // Arrange
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const { fixture } = await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const createdTimers = setIntervalSpy.mock.results.map((result) => result.value);

    // Act
    fixture.destroy();

    // Assert
    expect(createdTimers.length).toBeGreaterThan(0);
    for (const timer of createdTimers) expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    vi.restoreAllMocks();
  });

  it("keeps each gate's pending state isolated from the others when the list changes", async () => {
    // Arrange
    const approvals = signal([
      { id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: {}, status: 'pending', createdAt: 't' },
      { id: 'a2', sessionId: 's1', toolName: 'Write', toolInput: {}, status: 'pending', createdAt: 't' },
    ]);
    const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission' }]), approvals };
    const api = { decide: vi.fn(() => new Promise(() => {})) }; // never settles — a1 stays pending
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }] });
    const firstCard = screen.getAllByTestId('inbox-gate-card')[0];
    await userEvent.click(within(firstCard).getByTestId('inbox-allow'));
    await waitFor(() => expect((within(screen.getAllByTestId('inbox-gate-card')[0]).getByTestId('inbox-allow') as HTMLButtonElement).disabled).toBe(true));

    // Act — a new gate arrives at the front of the list, reordering the existing cards
    approvals.update((all) => [{ id: 'a3', sessionId: 's1', toolName: 'Read', toolInput: {}, status: 'pending', createdAt: 't' }, ...all]);
    await waitFor(() => expect(screen.getAllByTestId('inbox-gate-card')).toHaveLength(3));

    // Assert
    const cards = screen.getAllByTestId('inbox-gate-card');
    const byTool = (name: string) => cards.find((card) => within(card).getByTestId('inbox-gate-tool').textContent?.trim() === name)!;
    expect((within(byTool('Read')).getByTestId('inbox-allow') as HTMLButtonElement).disabled).toBe(false);
    expect((within(byTool('Bash')).getByTestId('inbox-allow') as HTMLButtonElement).disabled).toBe(true);
    expect((within(byTool('Write')).getByTestId('inbox-allow') as HTMLButtonElement).disabled).toBe(false);
  });

  it('drops a gate the moment it is resolved elsewhere, even with its own decision still in flight', async () => {
    // Arrange
    const approvals = signal([{ id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: {}, status: 'pending', createdAt: 't' }]);
    const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission' }]), approvals };
    let resolveDecide: (value: unknown) => void = () => {};
    const api = { decide: vi.fn(() => new Promise((resolve) => { resolveDecide = resolve; })) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }] });
    await userEvent.click(screen.getByTestId('inbox-allow'));

    // Act — another client resolves it first; the approval.resolved reducer removes it from the shared signal
    approvals.set([]);

    // Assert
    await waitFor(() => expect(screen.queryByTestId('inbox-gate-card')).toBeNull());
    resolveDecide({}); // the abandoned in-flight decide must not throw or resurrect the card
    await waitFor(() => expect(screen.queryByTestId('inbox-gate-card')).toBeNull());
  });

  it('keeps the header count in sync with the visible list once a gate is dismissed locally as already-resolved', async () => {
    // Arrange
    const api = { decide: vi.fn().mockRejectedValue(new ApiError(409, 'already_resolved')) };
    const events = {
      sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission' }]),
      approvals: signal([
        { id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: {}, status: 'pending', createdAt: 't' },
        { id: 'a2', sessionId: 's1', toolName: 'Write', toolInput: {}, status: 'pending', createdAt: 't' },
      ]),
    };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }] });

    // Act
    await userEvent.click(screen.getAllByTestId('inbox-allow')[0]);
    await waitFor(() => expect(screen.getAllByTestId('inbox-gate-card')).toHaveLength(1));

    // Assert — one card left; the header badge must say so too, not the stale backend-signal count
    expect(screen.getByTestId('inbox-count')).toHaveTextContent('1');
  });

  it('does not re-serialize unchanged tool arguments on every age tick', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const toolInput = { command: 'x'.repeat(50_000) };
      const stringifySpy = vi.spyOn(JSON, 'stringify');
      const { fixture } = await render(InboxComponent, {
        providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents({ toolInput }) }],
      });
      const callsAfterRender = stringifySpy.mock.calls.filter((call) => call[0] === toolInput).length;

      // Act — three age ticks; the approval itself never changes
      await vi.advanceTimersByTimeAsync(3000);
      await fixture.whenStable();

      // Assert
      const callsAfterTicks = stringifySpy.mock.calls.filter((call) => call[0] === toolInput).length;
      expect(callsAfterTicks).toBe(callsAfterRender);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('exposes the tab buttons with the ARIA tab role and aria-selected so assistive tech can navigate them', async () => {
    // Arrange & Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const gatesTab = screen.getByTestId('inbox-tab-gates');
    const questionsTab = screen.getByTestId('inbox-tab-questions');

    // Assert
    expect(gatesTab.getAttribute('role')).toBe('tab');
    expect(gatesTab.getAttribute('aria-selected')).toBe('true');
    expect(questionsTab.getAttribute('aria-selected')).toBe('false');
  });
});
