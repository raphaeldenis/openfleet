import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Session, WorkingState } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { fakeWorkingStateEvents, sessionOf, stateOf } from '../working-state/working-state-fixtures';
import { InboxComponent } from './inbox.component';

const agent = (id: string, patch: Partial<Session> = {}) => sessionOf({ id, name: `Agent ${id}`, emoji: '🤖', ...patch });

async function renderInbox(sessions: Session[], states: WorkingState[], approvals: unknown[] = []) {
  const events = { ...fakeWorkingStateEvents({ sessions, states }), approvals: signal(approvals), deliveredMessageIds: signal(new Set<string>()) };
  const api = { decide: vi.fn(), sendMessage: vi.fn().mockResolvedValue({ status: 'delivered', messageId: 'm1' }) };
  const view = await render(InboxComponent, {
    providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
  });
  return { ...view, events, api };
}

async function openQuestionsTab() {
  await userEvent.click(screen.getByTestId('inbox-tab-questions'));
}

const cards = () => screen.queryAllByTestId('inbox-attention-card');

describe('InboxComponent questions from agents', () => {
  it('user sees one card per open session that asks the human something or reports a blocker', async () => {
    await renderInbox(
      [agent('s1'), agent('s2'), agent('s3'), agent('s4'), agent('s5', { state: 'closed' })],
      [
        stateOf({ sessionId: 's1', questionsForHuman: ['which port?', 'which region?'] }),
        stateOf({ sessionId: 's2', blockers: ['no token'] }),
        stateOf({ sessionId: 's3', plan: ['busy'], todo: ['x'], remaining: ['y'], internalQuestions: ['not for the human'] }),
        stateOf({ sessionId: 's5', blockers: ['closed and stuck'] }),
      ],
    );

    await openQuestionsTab();

    expect(cards().map((card) => within(card).getByTestId('inbox-attention-session').textContent?.trim())).toEqual(['Agent s1', 'Agent s2']);
  });

  it('user reads the questions and the blockers of a session on its card, each on its own line', async () => {
    await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', questionsForHuman: ['which port?', 'which region?'], blockers: ['no token'] })]);

    await openQuestionsTab();

    const card = cards()[0];
    expect(within(card).getAllByTestId('inbox-attention-question').map((line) => line.textContent?.trim())).toEqual(['which port?', 'which region?']);
    expect(within(card).getAllByTestId('inbox-attention-blocker').map((line) => line.textContent?.trim())).toEqual(['no token']);
    expect(within(card).getByTestId('kind-badge')).toHaveTextContent('QUESTION');
  });

  it('user sees markdown in a question as typed', async () => {
    await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', questionsForHuman: ['use **port** `8080`?'] })]);

    await openQuestionsTab();

    const line = within(cards()[0]).getByTestId('inbox-attention-question');
    expect(line.textContent?.trim()).toBe('use **port** `8080`?');
    expect(line.querySelector('strong, code')).toBeNull();
  });

  it('user sees a card with only blockers show no questions block, and the other way round', async () => {
    await renderInbox([agent('s1'), agent('s2')], [stateOf({ sessionId: 's1', blockers: ['no token'] }), stateOf({ sessionId: 's2', questionsForHuman: ['which port?'] })]);

    await openQuestionsTab();

    const [blockedCard, askingCard] = cards();
    expect(within(blockedCard).queryByTestId('inbox-attention-question')).toBeNull();
    expect(within(askingCard).queryByTestId('inbox-attention-blocker')).toBeNull();
  });

  it('user sees a count on the Questions tab, and none when nothing is waiting', async () => {
    await renderInbox([agent('s1'), agent('s2')], [stateOf({ sessionId: 's1', blockers: ['a'] }), stateOf({ sessionId: 's2', questionsForHuman: ['b'] })]);

    expect(within(screen.getByTestId('inbox-tab-questions')).getByTestId('inbox-tab-count-questions')).toHaveTextContent('2');
    expect(within(screen.getByTestId('inbox-tab-gates')).queryByTestId('inbox-tab-count-questions')).toBeNull();
  });

  it('user sees no count on the Questions tab when no session needs attention', async () => {
    await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', plan: ['a'] })]);

    expect(screen.queryByTestId('inbox-tab-count-questions')).toBeNull();
  });

  it('user sees the page count add up gates and sessions needing attention', async () => {
    await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', blockers: ['a'] })], [{ id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: {}, status: 'pending', createdAt: 't' }]);

    expect(screen.getByTestId('inbox-count')).toHaveTextContent('2');
  });

  it('user sees a card leave the Inbox when the agent empties both sections', async () => {
    const { events, fixture } = await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', questionsForHuman: ['which port?'], blockers: ['no token'] })]);
    await openQuestionsTab();
    expect(cards()).toHaveLength(1);

    events.workingStates.set(new Map([['s1', stateOf({ sessionId: 's1', questionsForHuman: [], blockers: [], plan: ['carry on'] })]]));
    await fixture.whenStable();

    expect(cards()).toHaveLength(0);
    expect(screen.getByTestId('inbox-questions-empty')).toBeTruthy();
  });

  it('user still sees a card while one of the two sections has a line left', async () => {
    const { events, fixture } = await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', questionsForHuman: ['which port?'], blockers: ['no token'] })]);
    await openQuestionsTab();

    events.workingStates.set(new Map([['s1', stateOf({ sessionId: 's1', questionsForHuman: [], blockers: ['no token'] })]]));
    await fixture.whenStable();

    expect(cards()).toHaveLength(1);
    expect(within(cards()[0]).queryByTestId('inbox-attention-question')).toBeNull();
  });

  it('user sees a card leave the Inbox when its session closes', async () => {
    const { events, fixture } = await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', blockers: ['no token'] })]);
    await openQuestionsTab();

    events.sessions.set([agent('s1', { state: 'closed' })]);
    await fixture.whenStable();

    expect(cards()).toHaveLength(0);
  });

  it('user sees a card appear when a session writes a question while the Inbox is open', async () => {
    const { events, fixture } = await renderInbox([agent('s1')], []);
    await openQuestionsTab();
    expect(cards()).toHaveLength(0);

    events.workingStates.set(new Map([['s1', stateOf({ sessionId: 's1', questionsForHuman: ['which port?'] })]]));
    await fixture.whenStable();

    expect(cards()).toHaveLength(1);
  });

  describe('linking to the session', () => {
    it('user can follow the card to the terminal of a plain session', async () => {
      await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', blockers: ['a'] })]);
      await openQuestionsTab();

      expect(within(cards()[0]).getByTestId('inbox-attention-session')).toHaveAttribute('href', '/session/s1');
    });

    it('user can follow the card of a manager to its dashboard', async () => {
      await renderInbox([agent('m1', { role: 'manager' })], [stateOf({ sessionId: 'm1', blockers: ['a'] })]);
      await openQuestionsTab();

      expect(within(cards()[0]).getByTestId('inbox-attention-session')).toHaveAttribute('href', '/manager/m1');
    });
  });

  describe('replying', () => {
    it('user can answer from the card: the reply is sent as a message to that session', async () => {
      const user = userEvent.setup({ delay: null });
      const { api } = await renderInbox([agent('s1'), agent('s2')], [stateOf({ sessionId: 's1', questionsForHuman: ['which port?'] }), stateOf({ sessionId: 's2', blockers: ['no token'] })]);
      await openQuestionsTab();
      const secondCard = cards()[1];

      await user.type(within(secondCard).getByTestId('composer-input'), 'use the staging token');
      await user.click(within(secondCard).getByTestId('composer-send'));

      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledWith('s2', 'use the staging token');
    });

    it('user keeps a reply typed in one card apart from the other cards', async () => {
      const user = userEvent.setup({ delay: null });
      await renderInbox([agent('s1'), agent('s2')], [stateOf({ sessionId: 's1', blockers: ['a'] }), stateOf({ sessionId: 's2', blockers: ['b'] })]);
      await openQuestionsTab();

      await user.type(within(cards()[0]).getByTestId('composer-input'), 'first');

      expect(within(cards()[1]).getByTestId('composer-input')).toHaveValue('');
    });

    describe('a reply that outlives the card', () => {
      const replyField = () => within(cards()[0]).getByTestId('composer-input');
      const sendButton = () => within(cards()[0]).getByTestId('composer-send');

      async function renderWithDeferredSend() {
        const user = userEvent.setup({ delay: null });
        const view = await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', questionsForHuman: ['which port?'] })]);
        let resolveSend: (value: unknown) => void = () => {};
        let rejectSend: (reason: unknown) => void = () => {};
        view.api.sendMessage.mockImplementation(() => new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; }));
        await openQuestionsTab();
        return { user, ...view, resolveSend: (value: unknown) => resolveSend(value), rejectSend: (reason: unknown) => rejectSend(reason) };
      }

      type Rendered = Awaited<ReturnType<typeof renderWithDeferredSend>>;

      async function showTab({ user, fixture }: Pick<Rendered, 'user' | 'fixture'>, tab: 'gates' | 'questions') {
        await user.click(screen.getByTestId(`inbox-tab-${tab}`));
        await fixture.whenStable();
      }

      async function visitGatesAndComeBack(rendered: Pick<Rendered, 'user' | 'fixture'>) {
        await showTab(rendered, 'gates');
        await showTab(rendered, 'questions');
      }

      it('user finds the reply again after looking at the Gates tab', async () => {
        const rendered = await renderWithDeferredSend();
        await rendered.user.type(replyField(), 'use staging');
        await rendered.fixture.whenStable();

        await visitGatesAndComeBack(rendered);

        expect(replyField()).toHaveValue('use staging');
      });

      it('user cannot send the same reply twice by leaving the tab and coming back while it is on its way', async () => {
        const rendered = await renderWithDeferredSend();
        await rendered.user.type(replyField(), 'use staging');
        await rendered.user.click(sendButton());

        await visitGatesAndComeBack(rendered);
        await rendered.user.click(sendButton());

        expect(rendered.api.sendMessage).toHaveBeenCalledTimes(1);
        expect(sendButton()).toBeDisabled();
      });

      it('user finds an empty reply field after a reply was delivered while looking at the Gates tab', async () => {
        const rendered = await renderWithDeferredSend();
        await rendered.user.type(replyField(), 'use staging');
        await rendered.user.click(sendButton());
        await rendered.fixture.whenStable();
        await showTab(rendered, 'gates');

        rendered.resolveSend({ status: 'delivered', messageId: 'm1' });
        await rendered.fixture.whenStable();
        await showTab(rendered, 'questions');

        expect(replyField()).toHaveValue('');
      });

      it('user sees the failure and keeps the reply when the send fails while looking at the Gates tab', async () => {
        const rendered = await renderWithDeferredSend();
        const { user, fixture, rejectSend } = rendered;
        await user.type(replyField(), 'use staging');
        await user.click(sendButton());
        await fixture.whenStable();
        await showTab(rendered, 'gates');

        rejectSend(new Error('boom'));
        await fixture.whenStable();

        await waitFor(() => expect(screen.getByTestId('inbox-reply-failure')).toHaveAttribute('role', 'alert'));
        expect(screen.getByTestId('inbox-reply-failure')).toHaveTextContent('Agent s1');
        expect(screen.getByTestId('inbox-reply-failure-draft')).toHaveTextContent('use staging');
        await showTab(rendered, 'questions');
        expect(replyField()).toHaveValue('use staging');
        expect(screen.getByTestId('composer-send-error')).toBeTruthy();
        expect(screen.queryByTestId('inbox-reply-failure')).toBeNull();
      });

      it('user sees the failure and the reply when the session closes before the send fails', async () => {
        const { user, fixture, events, rejectSend } = await renderWithDeferredSend();
        await user.type(replyField(), 'use staging');
        await user.click(sendButton());
        events.sessions.set([agent('s1', { state: 'closed' })]);
        await fixture.whenStable();
        expect(cards()).toHaveLength(0);

        rejectSend(new Error('boom'));
        await fixture.whenStable();

        await waitFor(() => expect(screen.getByTestId('inbox-reply-failure')).toHaveAttribute('role', 'alert'));
        expect(screen.getByTestId('inbox-reply-failure-draft')).toHaveTextContent('use staging');
      });

      it('user can dismiss the failure of a reply to a closed session', async () => {
        const { user, fixture, events, rejectSend } = await renderWithDeferredSend();
        await user.type(replyField(), 'use staging');
        await user.click(sendButton());
        events.sessions.set([agent('s1', { state: 'closed' })]);
        rejectSend(new Error('boom'));
        await fixture.whenStable();

        await user.click(await screen.findByTestId('inbox-reply-failure-dismiss'));

        await waitFor(() => expect(screen.queryByTestId('inbox-reply-failure')).toBeNull());
      });

      it('user does not see a stale reply when a closed session asks again', async () => {
        const { user, fixture, events } = await renderWithDeferredSend();
        await user.type(replyField(), 'never sent');

        events.sessions.set([agent('s1', { state: 'closed' })]);
        await fixture.whenStable();
        events.sessions.set([agent('s1')]);
        await fixture.whenStable();

        expect(replyField()).toHaveValue('');
      });
    });

    it('user can press Escape in the reply field to leave it, and nothing is sent', async () => {
      const user = userEvent.setup({ delay: null });
      const { api } = await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', questionsForHuman: ['which port?'] })]);
      await openQuestionsTab();
      const reply = within(cards()[0]).getByTestId('composer-input');
      await user.click(reply);
      await user.keyboard('half a thought');
      expect(reply).toHaveFocus();

      await user.keyboard('{Escape}');

      expect(reply).not.toHaveFocus();
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(reply).toHaveValue('half a thought');
    });

    it('user can reach the session link, the reply field and Send with Tab, in that order', async () => {
      const user = userEvent.setup({ delay: null });
      await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', questionsForHuman: ['which port?'] })]);
      await openQuestionsTab();
      screen.getByTestId('inbox-tab-questions').focus();

      await user.tab();
      expect(within(cards()[0]).getByTestId('inbox-attention-session')).toHaveFocus();
      await user.tab();
      expect(within(cards()[0]).getByTestId('composer-input')).toHaveFocus();
      await user.tab();
      expect(within(cards()[0]).getByTestId('composer-send')).toHaveFocus();
    });
  });

  describe('with hostile data', () => {
    it('user reads a session name of 500 characters without a space in full inside its card', async () => {
      const longName = 'N'.repeat(500);
      await renderInbox([agent('s1', { name: longName })], [stateOf({ sessionId: 's1', blockers: ['a'] })]);
      await openQuestionsTab();

      const name = within(cards()[0]).getByTestId('inbox-attention-session');

      expect(name).toHaveTextContent(longName);
      expect(name).toBeVisible();
    });

    it('user reads a 300 character question and blocker without a space in full inside its card', async () => {
      const unbroken = 'x'.repeat(300);
      await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', questionsForHuman: [unbroken], blockers: [unbroken] })]);
      await openQuestionsTab();

      expect(within(cards()[0]).getByTestId('inbox-attention-question')).toHaveTextContent(unbroken);
      expect(within(cards()[0]).getByTestId('inbox-attention-blocker')).toHaveTextContent(unbroken);
    });

    it('user sees every one of 120 sessions needing attention, none dropped', async () => {
      const sessions = Array.from({ length: 120 }, (_, index) => agent(`s${index}`));
      await renderInbox(sessions, sessions.map((session) => stateOf({ sessionId: session.id, blockers: ['stuck'] })));
      await openQuestionsTab();

      await waitFor(() => expect(cards()).toHaveLength(120));
      expect(screen.getByTestId('inbox-count')).toHaveTextContent('99+');
    });

    it('user sees a bidirectional control in a session name shown as an escape, not applied', async () => {
      await renderInbox([agent('s1', { name: `safe${String.fromCharCode(0x202e)}evil` })], [stateOf({ sessionId: 's1', blockers: ['a'] })]);
      await openQuestionsTab();

      expect(within(cards()[0]).getByTestId('inbox-attention-session')).toHaveTextContent('safe<U+202E>evil');
    });

    it('user sees a bidirectional control in a question or a blocker shown as an escape, not applied', async () => {
      const rightToLeftOverride = String.fromCharCode(0x202e);
      await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', questionsForHuman: [`approve${rightToLeftOverride}txt.exe?`], blockers: [`stuck${rightToLeftOverride}on`] })]);
      await openQuestionsTab();

      const card = cards()[0];
      expect(within(card).getByTestId('inbox-attention-question')).toHaveTextContent('approve<U+202E>txt.exe?');
      expect(within(card).getByTestId('inbox-attention-blocker')).toHaveTextContent('stuck<U+202E>on');
    });

    it('user still reads a question written in Hebrew as it was written', async () => {
      const hebrew = 'איזה פורט?';
      await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', questionsForHuman: [hebrew] })]);
      await openQuestionsTab();

      expect(within(cards()[0]).getByTestId('inbox-attention-question').textContent?.trim()).toBe(hebrew);
    });

    it('user keeps every character of a question with zero-width characters', async () => {
      const withZeroWidth = `a${String.fromCharCode(0x200b)}b${String.fromCharCode(0xfeff)}c`;
      await renderInbox([agent('s1')], [stateOf({ sessionId: 's1', questionsForHuman: [withZeroWidth] })]);
      await openQuestionsTab();

      expect(within(cards()[0]).getByTestId('inbox-attention-question').textContent?.trim()).toBe(withZeroWidth);
    });

    it('user hears the true count on the page title while it shows "99+" past 99', async () => {
      const sessions = Array.from({ length: 120 }, (_, index) => agent(`s${index}`));
      await renderInbox(sessions, sessions.map((session) => stateOf({ sessionId: session.id, blockers: ['stuck'] })));

      expect(screen.getByTestId('inbox-count')).toHaveTextContent('99+');
      expect(screen.getByRole('img', { name: '120 items need you' })).toBe(screen.getByTestId('inbox-count'));
    });

    it('user sees zero-width and bidirectional controls in a session name shown as escapes', async () => {
      const name = `Le${String.fromCharCode(0x200b)}ad${String.fromCharCode(0x202e)}x`;
      await renderInbox([agent('s1', { name })], [stateOf({ sessionId: 's1', blockers: ['a'] })]);
      await openQuestionsTab();

      expect(within(cards()[0]).getByTestId('inbox-attention-session')).toHaveTextContent('Le<U+200B>ad<U+202E>x');
    });

    it('user keeps a reply typed in a card when another session starts asking above it', async () => {
      const user = userEvent.setup({ delay: null });
      const { events, fixture } = await renderInbox([agent('s1'), agent('s2')], [stateOf({ sessionId: 's2', blockers: ['b'] })]);
      await openQuestionsTab();
      await user.type(within(cards()[0]).getByTestId('composer-input'), 'half a reply');

      events.workingStates.set(new Map([['s1', stateOf({ sessionId: 's1', blockers: ['a'] })], ['s2', stateOf({ sessionId: 's2', blockers: ['b'], plan: ['refreshed'] })]]));
      await fixture.whenStable();

      const [firstCard, secondCard] = cards();
      expect(within(firstCard).getByTestId('composer-input')).toHaveValue('');
      expect(within(secondCard).getByTestId('composer-input')).toHaveValue('half a reply');
    });

    it('user sees the same card once when the same snapshot is replayed', async () => {
      const state = stateOf({ sessionId: 's1', questionsForHuman: ['which port?'] });
      const { events, fixture } = await renderInbox([agent('s1')], [state]);
      await openQuestionsTab();

      events.workingStates.set(new Map([['s1', { ...state }]]));
      events.workingStates.set(new Map([['s1', { ...state }]]));
      await fixture.whenStable();

      expect(cards()).toHaveLength(1);
      expect(within(cards()[0]).getAllByTestId('inbox-attention-question')).toHaveLength(1);
    });
  });
});
