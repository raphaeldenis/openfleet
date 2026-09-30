import { inputBinding, signal } from '@angular/core';
import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, WorkingState } from '@openfleet/shared';
import { FleetEventsService } from '../core/fleet-events.service';
import { StatePanelComponent } from './state-panel.component';
import { NOW_ISO, fakeWorkingStateEvents, minutesBeforeNow, sessionOf, stateOf } from './working-state-fixtures';

const toggle = () => screen.getByTestId('state-panel-toggle');
const body = () => screen.queryByTestId('state-panel-body');

async function renderPanel(options: Parameters<typeof fakeWorkingStateEvents>[0] = {}, session: Session = sessionOf()) {
  const events = fakeWorkingStateEvents({ sessions: [session], ...options });
  const view = await render(StatePanelComponent, {
    bindings: [inputBinding('session', () => session)],
    providers: [{ provide: FleetEventsService, useValue: events }],
  });
  return { ...view, events };
}

async function renderOpenPanel(state: Partial<WorkingState> = {}, session: Session = sessionOf()) {
  const view = await renderPanel({ states: [stateOf(state)] }, session);
  await userEvent.click(toggle());
  return view;
}

const SECTION_KEYS = ['plan', 'todo', 'remaining', 'questionsForHuman', 'internalQuestions', 'blockers'] as const;
const HEADINGS_IN_ORDER = ['Plan', 'Todo', 'Reste à faire', "Questions pour l'humain", 'Questions internes', 'Blocages'];

describe('StatePanelComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => vi.useRealTimers());

  it('user finds the state panel collapsed, so the terminal keeps the room', async () => {
    await renderPanel({ states: [stateOf({ plan: ['ship it'] })] });

    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(body()).toBeNull();
  });

  it('user can open the panel and read the six sections in order with their items', async () => {
    await renderOpenPanel({ plan: ['ship the panel'], todo: ['write tests', 'write code'], blockers: ['waiting on design'] });

    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    const headings = SECTION_KEYS.map((key) => within(screen.getByTestId(`state-section-${key}`)).getByTestId('state-section-heading').textContent?.trim());
    expect(headings).toEqual(HEADINGS_IN_ORDER);
    expect(screen.getByTestId('state-section-plan')).toHaveTextContent('ship the panel');
    expect(within(screen.getByTestId('state-section-todo')).getAllByTestId('state-item').map((item) => item.textContent?.trim())).toEqual(['write tests', 'write code']);
    expect(screen.getByTestId('state-section-blockers')).toHaveTextContent('waiting on design');
  });

  it('user sees "(rien)" in each of the six sections when the state is empty', async () => {
    await renderOpenPanel();

    for (const key of SECTION_KEYS) expect(within(screen.getByTestId(`state-section-${key}`)).getByTestId('state-section-empty')).toHaveTextContent('(rien)');
  });

  it('user can close the panel again', async () => {
    await renderOpenPanel();

    await userEvent.click(toggle());

    expect(body()).toBeNull();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('user sees plain text: markdown and markup in an item are shown as typed', async () => {
    await renderOpenPanel({ plan: ['**bold** `code` <b>tag</b> [link](http://x)'] });

    const item = within(screen.getByTestId('state-section-plan')).getByTestId('state-item');
    expect(item.textContent?.trim()).toBe('**bold** `code` <b>tag</b> [link](http://x)');
    expect(item.querySelector('b, strong, code, a')).toBeNull();
  });

  it.each([
    ['30 seconds ago', 0.5, 'updated just now'],
    ['1 minute ago', 1, 'updated 1 min ago'],
    ['12 minutes ago', 12, 'updated 12 min ago'],
  ])('user reads when the state was written: %s', async (_label, minutes, expected) => {
    await renderPanel({ states: [stateOf({ updatedAt: minutesBeforeNow(minutes) })] });

    expect(screen.getByTestId('state-panel-updated')).toHaveTextContent(expected);
  });

  it('user sees the age move on without a new event', async () => {
    const { fixture } = await renderPanel({ states: [stateOf({ updatedAt: minutesBeforeNow(1) })] });

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await fixture.whenStable();

    expect(screen.getByTestId('state-panel-updated')).toHaveTextContent('updated 5 min ago');
  });

  it('user sees the panel follow a new state written by the session', async () => {
    const { fixture, events } = await renderPanel({ states: [stateOf({ plan: ['old plan'] })] });
    await userEvent.click(toggle());

    events.workingStates.set(new Map([['s1', stateOf({ plan: ['new plan'] })]]));
    await fixture.whenStable();

    expect(screen.getByTestId('state-section-plan')).toHaveTextContent('new plan');
    expect(screen.getByTestId('state-section-plan')).not.toHaveTextContent('old plan');
  });

  describe('when the state is overdue', () => {
    it('user sees the chip and the reason in text, even with the panel collapsed', async () => {
      await renderPanel({ states: [stateOf({ updatedAt: minutesBeforeNow(45) })] });

      expect(within(toggle()).getByTestId('overdue-chip')).toBeTruthy();
      expect(screen.getByTestId('state-panel-overdue-reason')).toHaveTextContent('Written 45 minutes ago, limit 30 minutes');
    });

    it('user sees a "stale" mark when the state was written before the last spawn or close', async () => {
      await renderOpenPanel({ updatedAt: minutesBeforeNow(2), fleetChangedAt: minutesBeforeNow(1) });

      expect(screen.getByTestId('state-panel-stale')).toHaveTextContent('stale');
      expect(screen.getByTestId('state-panel-overdue-reason')).toHaveTextContent('Written before the last spawn or close');
    });

    it('user sees no "stale" mark on a state that is merely old', async () => {
      await renderOpenPanel({ updatedAt: minutesBeforeNow(45) });

      expect(screen.queryByTestId('state-panel-stale')).toBeNull();
    });

    it('user sees no chip, no reason and no mark on a fresh state', async () => {
      await renderOpenPanel({ updatedAt: minutesBeforeNow(1) });

      expect(screen.queryByTestId('overdue-chip')).toBeNull();
      expect(screen.queryByTestId('state-panel-overdue-reason')).toBeNull();
      expect(screen.queryByTestId('state-panel-stale')).toBeNull();
    });
  });

  describe('when there is no state to show', () => {
    it('user reads that no state is recorded yet for an open session', async () => {
      await renderPanel({ states: [] });
      await userEvent.click(toggle());

      expect(screen.getByTestId('state-panel-none')).toHaveTextContent('No state recorded yet');
      expect(screen.queryByTestId('state-section-plan')).toBeNull();
    });

    it('user reads that no state is kept for a closed session', async () => {
      await renderPanel({ states: [] }, sessionOf({ state: 'closed' }));
      await userEvent.click(toggle());

      expect(screen.getByTestId('state-panel-none')).toHaveTextContent('No state kept for a closed session');
    });

    it('user still reads the last state of a session that closed while the app was open', async () => {
      await renderPanel({ states: [stateOf({ plan: ['last plan'] })] }, sessionOf({ state: 'closed' }));
      await userEvent.click(toggle());

      expect(screen.getByTestId('state-section-plan')).toHaveTextContent('last plan');
    });

    it('user reads that this daemon does not report states, not that the session has none', async () => {
      await renderPanel({ states: [], reported: false });
      await userEvent.click(toggle());

      expect(screen.getByTestId('state-panel-none')).toHaveTextContent('State not reported by this daemon');
      expect(screen.queryByTestId('overdue-chip')).toBeNull();
    });
  });

  describe('with hostile data', () => {
    it('user sees a 300 character item without a space wrap inside the panel instead of stretching it', async () => {
      const unbrokenItem = 'x'.repeat(300);
      await renderOpenPanel({ plan: [unbrokenItem] });

      const item = within(screen.getByTestId('state-section-plan')).getByTestId('state-item');

      expect(item).toHaveTextContent(unbrokenItem);
      expect(getComputedStyle(item).overflowWrap).toBe('anywhere');
    });

    it('user can scroll a state of 120 items inside its own keyboard-reachable region, all items present', async () => {
      const twentyItems = (label: string) => Array.from({ length: 20 }, (_, index) => `${label} ${index}`);
      await renderOpenPanel({
        plan: twentyItems('plan'), todo: twentyItems('todo'), remaining: twentyItems('remaining'),
        questionsForHuman: twentyItems('question'), internalQuestions: twentyItems('internal'), blockers: twentyItems('blocker'),
      });

      expect(screen.getAllByTestId('state-item')).toHaveLength(120);
      expect(getComputedStyle(body()!).overflowY).toBe('auto');
      expect(body()).toHaveAttribute('tabindex', '0');
    });
  });

  describe('with the keyboard', () => {
    it('user can open and close the panel with Enter on the toggle', async () => {
      await renderPanel({ states: [stateOf()] });
      toggle().focus();

      await userEvent.keyboard('{Enter}');
      expect(body()).not.toBeNull();
      await userEvent.keyboard('{Enter}');

      expect(body()).toBeNull();
    });

    it('user can press Escape inside the open panel to close it and land back on the toggle', async () => {
      await renderOpenPanel({ plan: ['a'] });
      body()!.focus();

      await userEvent.keyboard('{Escape}');

      expect(body()).toBeNull();
      expect(toggle()).toHaveFocus();
    });

    it('user pressing Escape on a closed panel changes nothing', async () => {
      await renderPanel({ states: [stateOf()] });
      toggle().focus();

      await userEvent.keyboard('{Escape}');

      expect(body()).toBeNull();
      expect(toggle()).toHaveFocus();
    });
  });

  describe('when the user switches to another session', () => {
    it('user finds the panel of the new session closed, with its own state', async () => {
      const first = sessionOf({ id: 's1' });
      const second = sessionOf({ id: 's2', name: 'Legolas' });
      const shown = signal(first);
      const events = fakeWorkingStateEvents({ sessions: [first, second], states: [stateOf({ sessionId: 's1', plan: ['first plan'] }), stateOf({ sessionId: 's2', plan: ['second plan'] })] });
      const { fixture } = await render(StatePanelComponent, {
        bindings: [inputBinding('session', shown)],
        providers: [{ provide: FleetEventsService, useValue: events }],
      });
      await userEvent.click(toggle());
      expect(screen.getByTestId('state-section-plan')).toHaveTextContent('first plan');

      shown.set(second);
      await fixture.whenStable();

      expect(body()).toBeNull();
      await userEvent.click(toggle());
      expect(screen.getByTestId('state-section-plan')).toHaveTextContent('second plan');
    });
  });
});
