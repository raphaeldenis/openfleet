import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxComponent } from './inbox.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { VersionsService } from '../core/versions.service';
import { silentWorkingStateSignals } from '../working-state/working-state-fixtures';

function fakeEvents(approval: Record<string, unknown> = {}) {
  return {
    ...silentWorkingStateSignals(),
    sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission' }]),
    approvals: signal([{ id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, status: 'pending', createdAt: 't', ...approval }]),
  };
}

describe('InboxComponent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows zero-width and bidirectional controls in the session name of a gate as escapes', async () => {
    const name = `Gim${String.fromCharCode(0x200b)}li${String.fromCharCode(0x202e)}x`;
    const events = { ...fakeEvents(), sessions: signal([{ id: 's1', name, emoji: '⚔️', state: 'waiting_permission' }]) };

    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: events }] });

    expect(screen.getByTestId('inbox-gate-session')).toHaveTextContent('Gim<U+200B>li<U+202E>x');
  });

  it('shows a pending gate as a card with the session label, tool name and formatted arguments, and sends the decision', async () => {
    // Arrange
    const api = { decide: vi.fn().mockResolvedValue({}) };
    // Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const card = screen.getByTestId('inbox-gate-card');
    // Assert
    expect(within(card).getByTestId('inbox-gate-session')).toHaveTextContent('Gimli');
    expect(within(card).getByTestId('inbox-gate-avatar')).toHaveTextContent('⚔️');
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

  it('keeps the decision pair at the standard button size', async () => {
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });

    expect(screen.getByTestId('inbox-allow')).not.toHaveClass('of-btn--compact');
    expect(screen.getByTestId('inbox-deny')).not.toHaveClass('of-btn--compact');
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

  describe('layout containment (computed styles — jsdom cannot lay out)', () => {
    const UNBROKEN_TOKEN = 'A'.repeat(3000);

    async function renderWithUnbrokenToken() {
      return render(InboxComponent, {
        providers: [
          { provide: FleetApiService, useValue: { decide: vi.fn() } },
          { provide: FleetEventsService, useValue: fakeEvents({ toolInput: { command: UNBROKEN_TOKEN } }) },
        ],
      });
    }

    it('lets the host fill the outlet and shrink below its content, capped at the mockup width', async () => {
      // Arrange & Act
      const { fixture } = await renderWithUnbrokenToken();
      const host = getComputedStyle(fixture.nativeElement as HTMLElement);

      // Assert — mutation caught: dropping `flex:1` (column becomes content-sized), dropping `min-width:0` (host grows to the unbroken token), dropping the 54rem cap
      expect(host.flexGrow).toBe('1');
      expect(host.minWidth).toBe('0px');
      expect(host.maxWidth).toBe('54rem');
    });

    it('lets the list and every card shrink instead of stretching to their content', async () => {
      // Arrange & Act
      await renderWithUnbrokenToken();

      // Assert — mutation caught: removing `min-width:0` on `.gate-list` or `.gate-card`
      expect(getComputedStyle(screen.getByTestId('inbox-list')).minWidth).toBe('0px');
      expect(getComputedStyle(screen.getByTestId('inbox-gate-card')).minWidth).toBe('0px');
    });

    it('breaks an unbroken token inside the args block while keeping its scroll and height cap', async () => {
      // Arrange & Act
      await renderWithUnbrokenToken();
      const args = getComputedStyle(screen.getByTestId('inbox-gate-args'));

      // Assert — mutation caught: dropping `overflow-wrap:anywhere` (token forces the card 23000px wide), dropping `overflow:auto` or `max-height`
      expect(args.overflowWrap).toBe('anywhere');
      expect(args.overflow).toBe('auto');
      expect(args.maxHeight).toBe('10rem');
    });
  });

  it('shows the gate age in the compact "<n> s" / "<n> min" / "<n> h" format, not h:mm:ss', async () => {
    // Arrange
    const createdAt = new Date(Date.now() - 2 * 3600 * 1000 - 5000).toISOString();

    // Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents({ createdAt }) }] });

    // Assert
    expect(screen.getByTestId('inbox-gate-age')).toHaveTextContent(/^\s*2 h\s*$/);
  });

  it('lays the card out with an emoji avatar box, the kind badge in the meta row and a "Wants to run <tool>." sentence above the args', async () => {
    // Arrange & Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const card = screen.getByTestId('inbox-gate-card');
    const sentence = within(card).getByTestId('inbox-gate-sentence');
    const args = within(card).getByTestId('inbox-gate-args');

    // Assert
    expect(within(card).getByTestId('inbox-gate-avatar')).toBeInTheDocument();
    expect(within(within(card).getByTestId('inbox-gate-meta')).getByTestId('kind-badge')).toBeTruthy();
    expect(sentence).toHaveTextContent('Wants to run Bash.');
    expect(sentence.compareDocumentPosition(args) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('titles the page with an h1 and keeps the filter chips on the title row', async () => {
    // Arrange & Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const heading = screen.getByRole('heading', { level: 1 });
    const titleRow = screen.getByTestId('inbox-title-row');

    // Assert
    expect(heading).toHaveTextContent('Inbox');
    expect(titleRow.contains(heading)).toBe(true);
    expect(within(titleRow).getByTestId('inbox-filters')).toBeTruthy();
  });

  it('shows the gate under All with its count, and hides it under Questions', async () => {
    // Arrange
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    expect(screen.getByTestId('inbox-filter-all')).toHaveTextContent('1');
    expect(screen.getByTestId('inbox-gate-card')).toBeTruthy();

    // Act
    await userEvent.click(screen.getByTestId('inbox-filter-questions'));

    // Assert
    expect(screen.queryByTestId('inbox-gate-card')).toBeNull();
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent('Questions, gates and proposals show up here.');
  });

  it('shows the empty state with the mockup copy when nothing needs the human', async () => {
    // Arrange & Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: { ...fakeEvents(), approvals: signal([]) } }] });

    // Assert
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent('Nothing needs you');
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent('Questions, gates and proposals show up here.');
  });

  describe('background failures', () => {
    const deliveryFailure = {
      key: 'f1', sessionId: 's1', at: '2026-09-30T10:00:00.000Z',
      envelope: { error: 'delivery_failed', kind: 'unavailable', retry: 'later', message: 'daemon words' },
    };
    const internalFailure = {
      key: 'f2', sessionId: 's1', at: '2026-09-30T10:01:00.000Z',
      envelope: { error: 'launch_failed', kind: 'internal', retry: 'later', message: 'daemon words', id: '3f9a1c2e' },
    };

    function eventsWith(failures: unknown[]) {
      const dismissBackgroundFailure = vi.fn();
      const events = { ...fakeEvents(), backgroundFailures: signal(failures), dismissBackgroundFailure };
      return { events, dismissBackgroundFailure };
    }

    async function renderWith(failures: unknown[]) {
      const { events, dismissBackgroundFailure } = eventsWith(failures);
      await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: events }] });
      return { dismissBackgroundFailure };
    }

    it('lists a failure as an ISSUE item with the session name and user copy, never the daemon words', async () => {
      await renderWith([deliveryFailure]);

      const item = screen.getByTestId('inbox-issue');
      expect(item).toHaveTextContent('ISSUE');
      expect(item).toHaveTextContent('Gimli');
      expect(item).toHaveTextContent(/try again/i);
      expect(item).not.toHaveTextContent('daemon words');
      expect(item).not.toHaveTextContent('delivery_failed');
    });

    it('is a plain list item: no live region interrupts the user', async () => {
      await renderWith([deliveryFailure]);

      expect(screen.getByTestId('inbox-issue').closest('[role="alert"], [aria-live]')).toBeNull();
    });

    it('shows the ref of an internal failure', async () => {
      await renderWith([internalFailure]);

      expect(screen.getByTestId('inbox-issue')).toHaveTextContent('(ref 3f9a1c2e)');
    });

    it('copies the ref, the code, the message and the time with Copy details', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      await renderWith([internalFailure]);

      await userEvent.click(screen.getByTestId('inbox-issue-copy-details'));

      const copied = writeText.mock.calls[0]![0] as string;
      expect(copied).toContain('ref 3f9a1c2e');
      expect(copied).toContain('launch_failed');
      expect(copied).toContain('2026-09-30T10:01:00.000Z');
    });

    describe('the daemon version line of Copy details', () => {
      async function copiedDetailsWith(daemonVersion: string | null): Promise<string> {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
        const { events } = eventsWith([internalFailure]);
        await render(InboxComponent, {
          providers: [
            { provide: FleetApiService, useValue: { decide: vi.fn() } },
            { provide: FleetEventsService, useValue: events },
            { provide: VersionsService, useValue: { daemonVersion: signal(daemonVersion) } },
          ],
        });

        await userEvent.click(screen.getByTestId('inbox-issue-copy-details'));

        return writeText.mock.calls[0]![0] as string;
      }

      it('names the daemon version when it is known', async () => {
        expect(await copiedDetailsWith('1.2.3')).toContain('daemon: 1.2.3');
      });

      it('leaves the daemon line out when the version is unknown', async () => {
        expect(await copiedDetailsWith(null)).not.toContain('daemon:');
      });
    });

    it('copies nothing but those fields, whatever else the envelope carries', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      const envelopeWithForeignFields = { ...internalFailure.envelope, hint: 'see /Users/ana/.openfleet', detail: { token: 'Bearer abc123' } };
      await renderWith([{ ...internalFailure, envelope: envelopeWithForeignFields }]);

      await userEvent.click(screen.getByTestId('inbox-issue-copy-details'));

      expect(writeText.mock.calls[0]![0]).not.toMatch(/bearer|abc123|\/Users\//i);
    });

    describe('daemon words of a hostile envelope', () => {
      const hostileEnvelope = {
        error: 'future_failure', kind: 'internal', retry: 'never', id: 'c0ffee01',
        message: 'open /Users/review-user/private; Authorization: Bearer SYNTHETIC_TOKEN_123; safe‮evil​',
        hint: 'hint⁦hidden⁩',
      };
      const hostileFailure = { key: 'f9', sessionId: 's1', at: '2026-09-30T10:02:00.000Z', envelope: hostileEnvelope };

      it('shows the message of an unknown code without credentials or home path, and its invisible characters as escapes', async () => {
        await renderWith([hostileFailure]);

        const copy = screen.getByTestId('inbox-issue-copy');
        expect(copy).toHaveTextContent('safe<U+202E>evil<U+200B>');
        expect(copy).toHaveTextContent('Hint<U+2066>hidden<U+2069>');
        expect(copy.textContent).not.toMatch(/SYNTHETIC_TOKEN_123|review-user|[‮​⁦⁩]/);
      });

      it('copies the message of a known code without credentials, home path or raw invisible characters', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
        await renderWith([{ ...hostileFailure, envelope: { ...hostileEnvelope, error: 'launch_failed' } }]);

        await userEvent.click(screen.getByTestId('inbox-issue-copy-details'));

        const copied = writeText.mock.calls[0]![0] as string;
        expect(copied).toContain('safe<U+202E>evil<U+200B>');
        expect(copied).not.toMatch(/SYNTHETIC_TOKEN_123|review-user|[‮​]/);
      });
    });

    it('draws Dismiss and Copy details as compact secondary actions, as the Inbox design does', async () => {
      await renderWith([deliveryFailure]);

      expect(screen.getByTestId('inbox-issue-dismiss')).toHaveClass('of-btn--compact');
      expect(screen.getByTestId('inbox-issue-copy-details')).toHaveClass('of-btn--compact');
    });

    it('dismisses an item on request', async () => {
      const { dismissBackgroundFailure } = await renderWith([deliveryFailure]);

      await userEvent.click(screen.getByTestId('inbox-issue-dismiss'));

      expect(dismissBackgroundFailure).toHaveBeenCalledWith('f1');
    });

    it('shows no issue section when nothing failed in the background', async () => {
      await renderWith([]);

      expect(screen.queryByTestId('inbox-issue')).toBeNull();
    });

    it('does not claim that nothing needs you while an issue is listed', async () => {
      const events = { sessions: signal([]), approvals: signal([]), ...silentWorkingStateSignals(), backgroundFailures: signal([deliveryFailure]), dismissBackgroundFailure: vi.fn() };

      await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: events }] });

      expect(screen.getByTestId('inbox-issue')).toBeTruthy();
      expect(screen.queryByText('Nothing needs you')).toBeNull();
    });

    describe('focus after Dismiss', () => {
      const secondDeliveryFailure = { ...deliveryFailure, key: 'f3' };

      async function renderWithRealDismissal(failures: unknown[]) {
        const backgroundFailures = signal(failures);
        const dismissBackgroundFailure = (key: string) => backgroundFailures.update((all) => all.filter((failure) => (failure as { key: string }).key !== key));
        const events = { ...fakeEvents(), backgroundFailures, dismissBackgroundFailure };
        await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: events }] });
      }

      it('moves to the Dismiss button of the next issue', async () => {
        await renderWithRealDismissal([deliveryFailure, secondDeliveryFailure]);
        const [firstDismiss] = screen.getAllByTestId('inbox-issue-dismiss');

        await userEvent.click(firstDismiss!);

        await vi.waitFor(() => {
          expect(screen.getAllByTestId('inbox-issue')).toHaveLength(1);
          expect(document.activeElement).toBe(screen.getByTestId('inbox-issue-dismiss'));
        });
      });

      it('moves to the Inbox heading when the last issue is dismissed, so a keyboard user does not land on the page body', async () => {
        await renderWithRealDismissal([deliveryFailure]);

        await userEvent.click(screen.getByTestId('inbox-issue-dismiss'));

        await vi.waitFor(() => {
          expect(screen.queryByTestId('inbox-issue')).toBeNull();
          expect(document.activeElement).toBe(screen.getByRole('heading', { name: /inbox/i }));
        });
      });
    });
  });

  it('shows a "Nothing needs you" empty state and hides the count pill when there are no gates waiting', async () => {
    // Arrange
    const events = { sessions: signal([]), approvals: signal([]), ...silentWorkingStateSignals() };

    // Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: events }] });
    const empty = screen.getByTestId('inbox-empty');

    // Assert
    expect(empty).toHaveTextContent('Nothing needs you');
    expect(empty).toHaveTextContent('Questions, gates and proposals show up here.');
    expect(screen.queryByTestId('inbox-count')).toBeNull();
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
    const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission' }]), approvals, ...silentWorkingStateSignals() };
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
    const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission' }]), approvals, ...silentWorkingStateSignals() };
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
      ...silentWorkingStateSignals(),
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

  it('exposes the filter pills as toggle buttons whose pressed state follows the chosen filter', async () => {
    // Arrange & Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const allPill = screen.getByTestId('inbox-filter-all');
    const questionsPill = screen.getByTestId('inbox-filter-questions');

    // Assert
    expect(allPill.getAttribute('aria-pressed')).toBe('true');
    expect(questionsPill.getAttribute('aria-pressed')).toBe('false');
  });

  describe('bidi control characters', () => {
    const RIGHT_TO_LEFT_OVERRIDE = '‮';
    const ISOLATE_OPEN = '⁦';
    const ANY_BIDI_CONTROL = /[؜‎‏‪-‮⁦-⁩]/;

    async function renderSpoofedGate() {
      const events = fakeEvents({ toolName: `Ba${RIGHT_TO_LEFT_OVERRIDE}sh`, toolInput: { command: `echo ${RIGHT_TO_LEFT_OVERRIDE}gpj.exe ${ISOLATE_OPEN}` } });
      const api = { decide: vi.fn().mockResolvedValue({}) };
      await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }] });
      return { api, events };
    }

    it('shows them as visible escapes in the tool name and the arguments instead of reordering the text', async () => {
      // Arrange & Act
      await renderSpoofedGate();

      // Assert
      const toolName = screen.getByTestId('inbox-gate-tool').textContent ?? '';
      const args = screen.getByTestId('inbox-gate-args').textContent ?? '';
      expect(toolName).not.toMatch(ANY_BIDI_CONTROL);
      expect(args).not.toMatch(ANY_BIDI_CONTROL);
      expect(toolName.trim()).toBe('Ba<U+202E>sh');
      expect(args).toContain('echo <U+202E>gpj.exe <U+2066>');
    });

    it('never alters the data: the decision still targets the approval id and the shared approval keeps its raw characters', async () => {
      // Arrange
      const { api, events } = await renderSpoofedGate();

      // Act
      await userEvent.click(screen.getByTestId('inbox-allow'));

      // Assert
      expect(api.decide).toHaveBeenCalledWith('a1', 'allow');
      expect(events.approvals()[0].toolName).toBe(`Ba${RIGHT_TO_LEFT_OVERRIDE}sh`);
    });
  });

  describe('gate derivation cost', () => {
    const twoSessions = () => [
      { id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission' },
      { id: 's2', name: 'Legolas', emoji: '🏹', state: 'working' },
    ];

    it('does not re-format unchanged tool arguments when an unrelated session changes, yet keeps session labels live', async () => {
      // Arrange
      const toolInput = { command: 'x'.repeat(50_000) };
      const events = { sessions: signal(twoSessions()), approvals: signal([{ id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput, status: 'pending', createdAt: 't' }]), ...silentWorkingStateSignals() };
      const stringifySpy = vi.spyOn(JSON, 'stringify');
      try {
        const { fixture } = await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: events }] });
        const formatCalls = () => stringifySpy.mock.calls.filter((call) => call[0] === toolInput).length;
        const callsAfterRender = formatCalls();

        // Act — an unrelated session event, then the owning session is renamed
        events.sessions.update((all) => all.map((s) => (s.id === 's2' ? { ...s, state: 'idle' } : s)));
        await fixture.whenStable();
        events.sessions.update((all) => all.map((s) => (s.id === 's1' ? { ...s, name: 'Gimli the Bold' } : s)));
        await fixture.whenStable();

        // Assert
        expect(screen.getByTestId('inbox-gate-session')).toHaveTextContent('Gimli the Bold');
        expect(formatCalls()).toBe(callsAfterRender);
      } finally {
        stringifySpy.mockRestore();
      }
    });

    it('re-formats the arguments of an approval whose tool input changed', async () => {
      // Arrange
      const events = { sessions: signal(twoSessions()), approvals: signal([{ id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' }, status: 'pending', createdAt: 't' }]), ...silentWorkingStateSignals() };
      const { fixture } = await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: events }] });

      // Act
      events.approvals.update((all) => all.map((a) => ({ ...a, toolInput: { command: 'pwd' } })));
      await fixture.whenStable();

      // Assert
      expect(screen.getByTestId('inbox-gate-args')).toHaveTextContent('"command": "pwd"');
    });
  });
});
