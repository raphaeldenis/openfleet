import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { MANAGER_ROLE, type Session, type SessionCloseReason } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { connectFakeDaemon, withoutRealTerminal } from '../testing/session-view.testing';

const SIGTERM_EXIT_CODE = 143;

function openSession(): Session {
  return {
    id: 's1', name: 'Gimli', emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'idle', stateSince: 't', permissionMode: 'manual', createdAt: 't',
  } as Session;
}

async function renderOpenSession(reopenSession = vi.fn().mockResolvedValue({})) {
  const api = { reopenSession };
  const { fixture } = await render(SessionViewComponent, {
    bindings: [inputBinding('sessionId', () => 's1')],
    providers: [{ provide: FleetApiService, useValue: api }],
    ...withoutRealTerminal,
  });
  const daemon = await connectFakeDaemon(fixture);
  await daemon.send({ type: 'snapshot', sessions: [openSession()], approvals: [], managers: [] });
  return { daemon };
}

const strip = () => screen.queryByTestId('lifecycle-banner');
const card = () => screen.getByTestId('session-closed-footer');

interface CloseScenario {
  label: string;
  closes: { exitCode?: number; reason?: SessionCloseReason };
  stripText?: string;
  cardTitle: string;
}

const CLOSE_SCENARIOS: CloseScenario[] = [
  { label: 'closed_by_user', closes: { exitCode: SIGTERM_EXIT_CODE, reason: 'closed_by_user' }, cardTitle: 'Closed · exit 143' },
  { label: 'a clean exit 0', closes: { exitCode: 0 }, cardTitle: 'Closed · exit 0' },
  {
    label: 'a non-zero harness_exit', closes: { exitCode: 1, reason: 'harness_exit' }, cardTitle: 'Closed · exit 1',
    stripText: 'Agent process exited',
  },
  { label: 'a non-zero exit without reason', closes: { exitCode: 1 }, cardTitle: 'Closed · exit 1', stripText: 'Agent process exited' },
  { label: 'launch_failed', closes: { reason: 'launch_failed' }, cardTitle: 'Not running', stripText: 'Agent could not start' },
  { label: 'daemon_shutdown', closes: { exitCode: SIGTERM_EXIT_CODE, reason: 'daemon_shutdown' }, cardTitle: 'Closed', stripText: 'Daemon stopped' },
  { label: 'resume_timeout', closes: { reason: 'resume_timeout' }, cardTitle: 'Not running', stripText: 'Resume timed out' },
  { label: 'conversation_not_found', closes: { exitCode: 1, reason: 'conversation_not_found' }, cardTitle: 'Not running', stripText: 'Conversation not found' },
];

describe('what a closed session shows, per close reason', () => {
  it.each(CLOSE_SCENARIOS)('for $label: a strip only when there is something to explain, and a titled card', async ({ closes, stripText, cardTitle }) => {
    // Arrange
    const { daemon } = await renderOpenSession();

    // Act
    await daemon.send({ type: 'session.closed', sessionId: 's1', ...closes });

    // Assert
    await waitFor(() => expect(card()).toHaveTextContent(cardTitle));
    if (stripText) expect(strip()).toHaveTextContent(stripText);
    else expect(strip()).toBeNull();
  });

  it.each(CLOSE_SCENARIOS)('for $label: the situation is said once and the card has only a title, a body or actions', async ({ closes, label }) => {
    // Arrange
    const { daemon } = await renderOpenSession();

    // Act
    await daemon.send({ type: 'session.closed', sessionId: 's1', ...closes });

    // Assert
    await waitFor(() => expect(card()).toBeTruthy());
    if (strip()) expect(card().textContent).not.toContain(screen.getByTestId('lifecycle-message').textContent);
    else expect(card()).toHaveTextContent('Worktree kept');
    const buttons = within(card()).getAllByRole('button');
    const expectedButtons = label === 'conversation_not_found' ? ['Reopen fresh'] : ['↻ Resume in worktree', 'Reopen fresh'];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(expectedButtons);
  });

  it.each(CLOSE_SCENARIOS)('for $label: "Reopen fresh" and, when it is offered, "Resume in worktree" are enabled', async ({ closes, label }) => {
    // Arrange
    const { daemon } = await renderOpenSession();

    // Act
    await daemon.send({ type: 'session.closed', sessionId: 's1', ...closes });

    // Assert
    await waitFor(() => expect(card()).toBeTruthy());
    if (label !== 'conversation_not_found') expect(screen.getByRole('button', { name: /resume in worktree/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /reopen fresh/i })).toBeEnabled();
  });

  it('for conversation_not_found: does not offer to resume a conversation that is gone', async () => {
    // Arrange
    const { daemon } = await renderOpenSession();

    // Act
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 1, reason: 'conversation_not_found' });

    // Assert
    await waitFor(() => expect(card()).toBeTruthy());
    expect(screen.queryByRole('button', { name: /resume in worktree/i })).toBeNull();
    expect(screen.getByRole('button', { name: /reopen fresh/i })).toBeEnabled();
  });

  it('for conversation_not_found: the strip says the transcript is gone, with a semicolon', async () => {
    // Arrange
    const { daemon } = await renderOpenSession();

    // Act
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 1, reason: 'conversation_not_found' });

    // Assert
    expect(await screen.findByTestId('lifecycle-message')).toHaveTextContent('The transcript for this session is gone; start a new session from its handoff.');
  });

  it.each([
    ['conversation_not_found', { exitCode: 1, reason: 'conversation_not_found' }],
    ['launch_failed', { reason: 'launch_failed' }],
    ['resume_timeout', { reason: 'resume_timeout' }],
    ['harness_exit', { exitCode: 1, reason: 'harness_exit' }],
  ] as const)('for %s: a compact Copy details on the strip copies the session ref and the code', async (code, closes) => {
    // Arrange
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { daemon } = await renderOpenSession();
    await daemon.send({ type: 'session.closed', sessionId: 's1', ...closes });
    const copyDetails = await within(await screen.findByTestId('lifecycle-banner')).findByRole('button', { name: 'Copy details' });

    // Act
    await userEvent.click(copyDetails);

    // Assert
    expect(copyDetails).toHaveClass('of-btn--compact');
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain('ref s1');
    expect(copied).toContain(`code: ${code}`);
    vi.unstubAllGlobals();
  });

  it.each([
    ['daemon_shutdown', { exitCode: SIGTERM_EXIT_CODE, reason: 'daemon_shutdown' }],
    ['a clean exit', { exitCode: 0 }],
  ] as const)('for %s: no Copy details button', async (_label, closes) => {
    // Arrange
    const { daemon } = await renderOpenSession();

    // Act
    await daemon.send({ type: 'session.closed', sessionId: 's1', ...closes });

    // Assert
    await waitFor(() => expect(card()).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Copy details' })).toBeNull();
  });

  it('for a refused reopen request: says why on the strip, and never calls it a timeout', async () => {
    // Arrange
    const reopenSession = vi.fn().mockRejectedValue(new ApiError(409, 'boom', 'directory_missing'));
    const { daemon } = await renderOpenSession(reopenSession);
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

    // Act
    await userEvent.click(await screen.findByRole('button', { name: /resume in worktree/i }));

    // Assert
    await waitFor(() => expect(strip()).toHaveTextContent('Resume failed'));
    expect(screen.getByTestId('lifecycle-message')).toHaveTextContent('directory no longer exists');
    expect(strip()).not.toHaveTextContent(/timed out/i);
    expect(card()).toHaveTextContent('Not running');
    expect(screen.getByRole('button', { name: /resume in worktree/i })).toBeEnabled();
  });
});

describe('reopening a closed session fresh', () => {
  const closeTheSession = async (daemon: Awaited<ReturnType<typeof renderOpenSession>>['daemon']) => {
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });
    await waitFor(() => expect(card()).toBeTruthy());
  };

  it('asks for confirmation first and calls nothing before the user confirms', async () => {
    // Arrange
    const reopenSession = vi.fn().mockResolvedValue({});
    const { daemon } = await renderOpenSession(reopenSession);
    await closeTheSession(daemon);

    // Act
    await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

    // Assert
    expect(screen.getByTestId('reopen-fresh-confirm-text')).toHaveTextContent('Start a new conversation? The previous one is not resumed.');
    expect(reopenSession).not.toHaveBeenCalled();
  });

  it('reopens the session fresh, once, when the user confirms', async () => {
    // Arrange
    const reopenSession = vi.fn().mockResolvedValue({});
    const { daemon } = await renderOpenSession(reopenSession);
    await closeTheSession(daemon);
    await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Start new conversation' }));

    // Assert
    expect(reopenSession).toHaveBeenCalledTimes(1);
    expect(reopenSession).toHaveBeenCalledWith('s1', 'fresh');
    expect(screen.queryByTestId('reopen-fresh-confirm')).toBeNull();
  });

  it('reopens nothing when the user cancels', async () => {
    // Arrange
    const reopenSession = vi.fn().mockResolvedValue({});
    const { daemon } = await renderOpenSession(reopenSession);
    await closeTheSession(daemon);
    await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Assert
    expect(reopenSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reopen-fresh-confirm')).toBeNull();
  });

  it('says how many live children keep running', async () => {
    // Arrange
    const { daemon } = await renderOpenSession();
    const child = (id: string, state: Session['state']) => ({ ...openSession(), id, name: id, parentId: 's1', state }) as Session;
    await daemon.send({ type: 'session.created', session: child('c1', 'generating') });
    await daemon.send({ type: 'session.created', session: child('c2', 'idle') });
    await daemon.send({ type: 'session.created', session: child('c3', 'closed') });
    await closeTheSession(daemon);

    // Act
    await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

    // Assert
    expect(screen.getByTestId('reopen-fresh-confirm-text')).toHaveTextContent('2 live children keep running.');
  });

  it('says that the daemon refused, on the strip, when the reopen fails', async () => {
    // Arrange
    const reopenSession = vi.fn().mockRejectedValue(new ApiError(409, 'boom', 'directory_missing'));
    const { daemon } = await renderOpenSession(reopenSession);
    await closeTheSession(daemon);
    await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Start new conversation' }));

    // Assert
    await waitFor(() => expect(strip()).toHaveTextContent('Resume failed'));
    expect(screen.getByTestId('lifecycle-message')).toHaveTextContent('directory no longer exists');
    expect(screen.getByRole('button', { name: /reopen fresh/i })).toBeEnabled();
  });

  it('says it starts a new conversation, not that it reattaches, while the session starts', async () => {
    // Arrange
    let resolveReopen: (value: unknown) => void = () => {};
    const reopenSession = vi.fn(() => new Promise((resolve) => { resolveReopen = resolve; }));
    const { daemon } = await renderOpenSession(reopenSession);
    await closeTheSession(daemon);
    await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Start new conversation' }));

    // Assert
    expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('Starting a new conversation');
    expect(screen.getByTestId('lifecycle-banner')).not.toHaveTextContent('Reattaching');
    resolveReopen({});
  });

  it('says in the question that a lone live child keeps running, in the singular', async () => {
    // Arrange
    const { daemon } = await renderOpenSession();
    await daemon.send({ type: 'session.created', session: { ...openSession(), id: 'c1', name: 'c1', parentId: 's1', state: 'idle' } as Session });
    await closeTheSession(daemon);

    // Act
    await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

    // Assert
    expect(screen.getByTestId('reopen-fresh-confirm-text')).toHaveTextContent('1 live child keeps running.');
  });

  it('says that a manager is started again from its mission', async () => {
    // Arrange
    const { daemon } = await renderOpenSession();
    await daemon.send({ type: 'session.created', session: { ...openSession(), id: 's1', role: MANAGER_ROLE } as Session });
    await closeTheSession(daemon);

    // Act
    await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

    // Assert
    expect(screen.getByTestId('reopen-fresh-confirm-text')).toHaveTextContent('Its mission is sent again as the first prompt.');
  });

  it('says that any other session gets its original brief again when one is stored, and nothing otherwise', async () => {
    // Arrange
    const { daemon } = await renderOpenSession();
    await closeTheSession(daemon);

    // Act
    await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

    // Assert
    expect(screen.getByTestId('reopen-fresh-confirm-text')).toHaveTextContent('Its original brief is sent again as the first prompt when one is stored, otherwise it starts with no prompt.');
  });

  it('announces the question in a live region', async () => {
    // Arrange
    const { daemon } = await renderOpenSession();
    await closeTheSession(daemon);

    // Act
    await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

    // Assert
    expect(screen.getByTestId('reopen-fresh-confirm').closest('[aria-live]')).not.toBeNull();
  });

  describe('with the keyboard', () => {
    it('puts the focus on Cancel, the safe answer, when the question opens', async () => {
      // Arrange
      const { daemon } = await renderOpenSession();
      await closeTheSession(daemon);

      // Act
      await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

      // Assert
      await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    });

    it('cancels on Escape and gives the focus back to "Reopen fresh"', async () => {
      // Arrange
      const reopenSession = vi.fn().mockResolvedValue({});
      const { daemon } = await renderOpenSession(reopenSession);
      await closeTheSession(daemon);
      await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());

      // Act
      await userEvent.keyboard('{Escape}');

      // Assert
      expect(screen.queryByTestId('reopen-fresh-confirm')).toBeNull();
      expect(reopenSession).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /reopen fresh/i })).toHaveFocus();
    });

    it('gives the focus back to "Reopen fresh" when the user cancels', async () => {
      // Arrange
      const { daemon } = await renderOpenSession();
      await closeTheSession(daemon);
      await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

      // Act
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      // Assert
      expect(screen.getByRole('button', { name: /reopen fresh/i })).toHaveFocus();
    });

    it('moves the focus to the terminal area, not to the page, when the user starts the new conversation', async () => {
      // Arrange
      const { daemon } = await renderOpenSession();
      await closeTheSession(daemon);
      await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));

      // Act
      await userEvent.click(screen.getByRole('button', { name: 'Start new conversation' }));
      await daemon.send({ type: 'session.reopened', sessionId: 's1' });

      // Assert
      expect(screen.getByTestId('terminal-area')).toHaveFocus();
    });
  });
});

describe('the question of a fresh start, once other things happen', () => {
  async function renderTwoClosedSessions(reopenSession = vi.fn().mockResolvedValue({})) {
    const shownSessionId = signal('s1');
    const { fixture } = await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', shownSessionId)],
      providers: [{ provide: FleetApiService, useValue: { reopenSession } }],
      ...withoutRealTerminal,
    });
    const daemon = await connectFakeDaemon(fixture);
    const closed = (id: string) => ({ ...openSession(), id, name: id, state: 'closed', exitCode: 0, closedAt: 't' }) as Session;
    await daemon.send({ type: 'snapshot', sessions: [closed('s1'), closed('s2')], approvals: [], managers: [] });
    const show = async (sessionId: string) => {
      shownSessionId.set(sessionId);
      fixture.detectChanges();
      await fixture.whenStable();
    };
    return { daemon, show };
  }

  it('is not asked again when the user comes back to the session after looking at another one', async () => {
    // Arrange
    const { show } = await renderTwoClosedSessions();
    await userEvent.click(await screen.findByRole('button', { name: /reopen fresh/i }));
    expect(screen.getByTestId('reopen-fresh-confirm')).toBeTruthy();

    // Act
    await show('s2');
    await show('s1');

    // Assert
    expect(screen.queryByTestId('reopen-fresh-confirm')).toBeNull();
  });

  it('goes away when the user resumes the session instead, and does not come back if that resume fails', async () => {
    // Arrange
    const reopenSession = vi.fn().mockRejectedValue(new ApiError(409, 'boom', 'directory_missing'));
    await renderTwoClosedSessions(reopenSession);
    await userEvent.click(await screen.findByRole('button', { name: /reopen fresh/i }));

    // Act
    await userEvent.click(screen.getByRole('button', { name: /resume in worktree/i }));

    // Assert
    await waitFor(() => expect(strip()).toHaveTextContent('Resume failed'));
    expect(screen.queryByTestId('reopen-fresh-confirm')).toBeNull();
  });
});

describe('the banner of a fresh start', () => {
  it('says "Reattaching" for a later relaunch of the same session that nobody asked to start fresh', async () => {
    // Arrange
    const { daemon } = await renderOpenSession();
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });
    await waitFor(() => expect(card()).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /reopen fresh/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Start new conversation' }));
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });
    expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('Starting a new conversation');
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't2' });

    // Act
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });

    // Assert
    expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('Reattaching to the same conversation');
    expect(screen.getByTestId('lifecycle-banner')).not.toHaveTextContent('new conversation');
  });
});
