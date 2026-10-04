import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxComponent } from './inbox.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { silentWorkingStateSignals } from '../working-state/working-state-fixtures';

const WAITING_SINCE = '2026-10-04T10:00:00.000Z';
const MINUTE_MS = 60_000;

const sessionOf = (patch: Record<string, unknown> = {}) => ({ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission', ...patch });

function eventsWith({ sessions = [sessionOf()], blocks = [{ sessionId: 's1', waitingSince: WAITING_SINCE }] }: { sessions?: unknown[]; blocks?: unknown[] } = {}) {
  const silentBlocks = signal(blocks);
  const dismissSilentBlock = vi.fn();
  const events = { ...silentWorkingStateSignals(), sessions: signal(sessions), approvals: signal([]), silentBlocks, dismissSilentBlock };
  return { events, silentBlocks, dismissSilentBlock };
}

async function renderInbox(events: unknown) {
  return render(InboxComponent, { providers: [provideRouter([]), { provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: events }] });
}

describe('InboxComponent silent blocks', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function atMinutesAfterPrompt(minutes: number): void {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(Date.parse(WAITING_SINCE) + minutes * MINUTE_MS);
  }

  it('lists the stuck session as an ISSUE item with the waiting sentence, the time and a link to the session', async () => {
    atMinutesAfterPrompt(5);
    const { events } = eventsWith();

    await renderInbox(events);

    const item = screen.getByTestId('inbox-issue');
    expect(item).toHaveTextContent('ISSUE');
    expect(screen.getByTestId('inbox-issue-copy')).toHaveTextContent("Waiting on a permission prompt for 5 min — Gimli can't continue until you decide.");
    expect(screen.getByTestId('inbox-issue-session')).toHaveAttribute('href', '/session/s1');
    expect(screen.getByTestId('inbox-issue-session')).toHaveTextContent('Gimli');
  });

  it('links a manager to its manager page', async () => {
    atMinutesAfterPrompt(5);
    const { events } = eventsWith({ sessions: [sessionOf({ role: 'manager' })] });

    await renderInbox(events);

    expect(screen.getByTestId('inbox-issue-session')).toHaveAttribute('href', '/manager/s1');
  });

  it('advances the minutes with the clock, without a new event', async () => {
    atMinutesAfterPrompt(5);
    const { events } = eventsWith();
    const { fixture } = await renderInbox(events);

    await vi.advanceTimersByTimeAsync(3 * MINUTE_MS);
    await fixture.whenStable();

    expect(screen.getByTestId('inbox-issue-copy')).toHaveTextContent('for 8 min');
  });

  it('names no tool, path or prompt content', async () => {
    atMinutesAfterPrompt(5);
    const { events } = eventsWith();
    events.approvals = signal([{ id: 'a1', sessionId: 's1', toolName: 'Write', toolInput: { file_path: '/Users/ana/secret.txt', content: 'TOKEN=abc123' }, status: 'pending', createdAt: WAITING_SINCE }]) as never;

    await renderInbox(events);

    const itemText = screen.getByTestId('inbox-issue').textContent ?? '';
    expect(itemText).not.toMatch(/Write|\/Users\/ana|secret|abc123/);
  });

  it('shows the item with a hostile session name escaped, as text', async () => {
    atMinutesAfterPrompt(5);
    const hostileName = `<img src=x onerror=alert(1)>Gim${String.fromCharCode(0x200b)}li${String.fromCharCode(0x202e)}`;
    const { events } = eventsWith({ sessions: [sessionOf({ name: hostileName })] });

    await renderInbox(events);

    const item = screen.getByTestId('inbox-issue');
    expect(item.querySelector('img')).toBeNull();
    expect(screen.getByTestId('inbox-issue-copy')).toHaveTextContent('<img src=x onerror=alert(1)>Gim<U+200B>li<U+202E>');
    expect(item.textContent).not.toMatch(/[​‮]/);
  });

  it('copies the code, the sentence without the session name, the time and nothing else with Copy details', async () => {
    atMinutesAfterPrompt(6);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { events } = eventsWith({ sessions: [sessionOf({ name: 'Gimli' })] });
    await renderInbox(events);

    await userEvent.click(screen.getByTestId('inbox-issue-copy-details'), { advanceTimers: vi.advanceTimersByTime });

    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain('code: permission_silent_block');
    expect(copied).toContain('message: Waiting on a permission prompt for 6 min.');
    expect(copied).toContain(`time: ${WAITING_SINCE}`);
    expect(copied).not.toContain('Gimli');
  });

  it('draws Dismiss and Copy details as compact secondary actions', async () => {
    atMinutesAfterPrompt(5);
    const { events } = eventsWith();

    await renderInbox(events);

    expect(screen.getByTestId('inbox-issue-dismiss')).toHaveClass('of-btn--compact');
    expect(screen.getByTestId('inbox-issue-copy-details')).toHaveClass('of-btn--compact');
  });

  it('dismisses the item on request', async () => {
    atMinutesAfterPrompt(5);
    const { events, dismissSilentBlock } = eventsWith();
    await renderInbox(events);

    await userEvent.click(screen.getByTestId('inbox-issue-dismiss'), { advanceTimers: vi.advanceTimersByTime });

    expect(dismissSilentBlock).toHaveBeenCalledWith(`s1@${WAITING_SINCE}`);
  });

  it('drops the item once the daemon reports the prompt decided', async () => {
    atMinutesAfterPrompt(5);
    const { events, silentBlocks } = eventsWith();
    const { fixture } = await renderInbox(events);

    silentBlocks.set([]);
    await fixture.whenStable();

    expect(screen.queryByTestId('inbox-issue')).toBeNull();
  });

  it('does not claim that nothing needs you while the item is listed', async () => {
    atMinutesAfterPrompt(5);
    const { events } = eventsWith();

    await renderInbox(events);

    expect(screen.queryByText('Nothing needs you')).toBeNull();
  });
});
