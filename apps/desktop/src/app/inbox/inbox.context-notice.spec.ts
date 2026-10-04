import { render, screen, within } from '@testing-library/angular/zoneless';
import { provideRouter } from '@angular/router';
import type { Session } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { InboxComponent } from './inbox.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { fakeWorkingStateEvents, sessionOf } from '../working-state/working-state-fixtures';

const managerWithNotice = (patch: Partial<Session> = {}) => sessionOf({ role: 'manager', contextNoticeTokens: 300_000, ...patch });

async function renderInbox(sessions: Session[]) {
  const events = fakeWorkingStateEvents({ sessions });
  const sessionsSignal = events.sessions;
  const rendered = await render(InboxComponent, { providers: [provideRouter([]), { provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: events }] });
  return { ...rendered, sessions: sessionsSignal };
}

describe('InboxComponent context notice', () => {
  it('lists a NOTICE item that names the session, the formatted tokens and the compact advice', async () => {
    await renderInbox([managerWithNotice()]);

    const item = screen.getByTestId('inbox-notice');
    expect(within(item).getByTestId('kind-badge')).toHaveTextContent('NOTICE');
    expect(screen.getByTestId('inbox-notice-copy')).toHaveTextContent('Gimli is at 300,000 tokens of context. A good moment to compact it.');
  });

  it('links the item to the manager page of the session', async () => {
    await renderInbox([managerWithNotice()]);

    expect(screen.getByTestId('inbox-notice-session')).toHaveAttribute('href', '/manager/s1');
    expect(screen.getByTestId('inbox-notice-session')).toHaveTextContent('Gimli');
  });

  it('links a session that is not a manager to its session page', async () => {
    await renderInbox([sessionOf({ contextNoticeTokens: 300_000 })]);

    expect(screen.getByTestId('inbox-notice-session')).toHaveAttribute('href', '/session/s1');
  });

  it('keeps one item per session and shows the current value when the threshold rises', async () => {
    const { sessions, fixture } = await renderInbox([managerWithNotice()]);

    sessions.set([managerWithNotice({ contextNoticeTokens: 500_000 })]);
    await fixture.whenStable();

    expect(screen.getAllByTestId('inbox-notice')).toHaveLength(1);
    expect(screen.getByTestId('inbox-notice-copy')).toHaveTextContent('is at 500,000 tokens');
  });

  it('drops the item when the session no longer reports a notice', async () => {
    const { sessions, fixture } = await renderInbox([managerWithNotice()]);

    sessions.set([managerWithNotice({ contextNoticeTokens: undefined })]);
    await fixture.whenStable();

    expect(screen.queryByTestId('inbox-notice')).toBeNull();
  });

  it('shows no item for a closed session that still carries a notice', async () => {
    await renderInbox([managerWithNotice({ state: 'closed' })]);

    expect(screen.queryByTestId('inbox-notice')).toBeNull();
  });

  it('shows no item for a session without a notice, and still says nothing needs the user', async () => {
    await renderInbox([sessionOf({ role: 'manager' })]);

    expect(screen.queryByTestId('inbox-notice')).toBeNull();
    expect(screen.getByText('Nothing needs you')).toBeTruthy();
  });

  it('does not say that nothing needs the user while a notice is listed', async () => {
    await renderInbox([managerWithNotice()]);

    expect(screen.queryByText('Nothing needs you')).toBeNull();
  });

  it('offers no action: no Dismiss and no button on the item', async () => {
    await renderInbox([managerWithNotice()]);

    expect(within(screen.getByTestId('inbox-notice')).queryAllByRole('button')).toHaveLength(0);
  });

  it('counts the notice in the Inbox header', async () => {
    await renderInbox([managerWithNotice()]);

    expect(screen.getByTestId('inbox-count')).toHaveAttribute('aria-label', '1 item needs you');
  });

  it('shows a hostile session name escaped, as text', async () => {
    const hostileName = `<img src=x onerror=alert(1)>Gim${String.fromCharCode(0x200b)}li${String.fromCharCode(0x202e)}`;

    await renderInbox([managerWithNotice({ name: hostileName })]);

    const item = screen.getByTestId('inbox-notice');
    expect(item.querySelector('img')).toBeNull();
    expect(screen.getByTestId('inbox-notice-copy')).toHaveTextContent('<img src=x onerror=alert(1)>Gim<U+200B>li<U+202E>');
    expect(item.textContent).not.toMatch(/[​‮]/);
  });
});
