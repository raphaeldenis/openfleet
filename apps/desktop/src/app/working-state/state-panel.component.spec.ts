import { inputBinding, signal } from '@angular/core';
import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, WorkingState } from '@openfleet/shared';
import { FleetEventsService } from '../core/fleet-events.service';
import { StatePanelComponent } from './state-panel.component';
import { NOW_ISO, fakeWorkingStateEvents, minutesBeforeNow, sessionOf, stateOf } from './working-state-fixtures';

const body = () => screen.queryByTestId('state-panel-body');

async function renderPanel(options: Parameters<typeof fakeWorkingStateEvents>[0] = {}, session: Session = sessionOf()) {
  const events = fakeWorkingStateEvents({ sessions: [session], ...options });
  const view = await render(StatePanelComponent, {
    bindings: [inputBinding('session', () => session)],
    providers: [{ provide: FleetEventsService, useValue: events }],
  });
  return { ...view, events };
}

async function renderPanelWith(state: Partial<WorkingState> = {}, session: Session = sessionOf()) {
  return renderPanel({ states: [stateOf(state)] }, session);
}

const SECTION_KEYS = ['plan', 'todo', 'remaining', 'questionsForHuman', 'internalQuestions', 'blockers'] as const;
const HEADINGS_IN_ORDER = ['Plan', 'Todo', 'Reste à faire', "Questions pour l'humain", 'Questions internes', 'Blocages'];

describe('StatePanelComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => vi.useRealTimers());

  it('user finds the state panel titled "State", with its sections showing without any click', async () => {
    await renderPanelWith({ plan: ['ship it'] });

    expect(screen.getByTestId('state-panel')).toHaveTextContent('State');
    expect(body()).not.toBeNull();
    expect(screen.getByTestId('state-section-plan')).toHaveTextContent('ship it');
  });

  it('user finds no toggle to open or close the state panel', async () => {
    await renderPanelWith({ plan: ['ship it'] });

    expect(screen.queryByTestId('state-panel-toggle')).toBeNull();
    expect(screen.queryByRole('button', { name: /state/i })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('user of a screen reader finds the body as a named region', async () => {
    await renderPanelWith({ plan: ['ship it'] });

    expect(screen.getByRole('region', { name: 'Working state' })).toBe(body());
  });

  it('user can read the six sections in order with their items', async () => {
    await renderPanelWith({ plan: ['ship the panel'], todo: ['write tests', 'write code'], blockers: ['waiting on design'] });

    const headings = SECTION_KEYS.map((key) => within(screen.getByTestId(`state-section-${key}`)).getByTestId('state-section-heading').textContent?.trim());
    expect(headings).toEqual(HEADINGS_IN_ORDER);
    expect(screen.getByTestId('state-section-plan')).toHaveTextContent('ship the panel');
    expect(within(screen.getByTestId('state-section-todo')).getAllByTestId('state-item').map((item) => item.textContent?.trim())).toEqual(['write tests', 'write code']);
    expect(screen.getByTestId('state-section-blockers')).toHaveTextContent('waiting on design');
  });

  it('user sees "(rien)" in each of the six sections when the state is empty', async () => {
    await renderPanelWith();

    for (const key of SECTION_KEYS) expect(within(screen.getByTestId(`state-section-${key}`)).getByTestId('state-section-empty')).toHaveTextContent('(rien)');
  });

  it('user sees plain text: markdown and markup in an item are shown as typed', async () => {
    await renderPanelWith({ plan: ['**bold** `code` <b>tag</b> [link](http://x)'] });

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

    events.workingStates.set(new Map([['s1', stateOf({ plan: ['new plan'] })]]));
    await fixture.whenStable();

    expect(screen.getByTestId('state-section-plan')).toHaveTextContent('new plan');
    expect(screen.getByTestId('state-section-plan')).not.toHaveTextContent('old plan');
  });

  describe('when the state is overdue', () => {
    it('user sees the chip and the reason in text', async () => {
      await renderPanel({ states: [stateOf({ updatedAt: minutesBeforeNow(45) })] });

      expect(screen.getByTestId('overdue-chip')).toHaveTextContent('state overdue');
      expect(screen.getByTestId('state-panel-overdue-reason')).toHaveTextContent('Written 45 minutes ago, limit 30 minutes');
    });

    it('user sees a "stale" mark when the state was written before the last spawn or close', async () => {
      await renderPanelWith({ updatedAt: minutesBeforeNow(2), fleetChangedAt: minutesBeforeNow(1) });

      expect(screen.getByTestId('state-panel-stale')).toHaveTextContent('stale');
      expect(screen.getByTestId('state-panel-overdue-reason')).toHaveTextContent('Written before the last spawn or close');
    });

    it('user sees no "stale" mark on a state that is merely old', async () => {
      await renderPanelWith({ updatedAt: minutesBeforeNow(45) });

      expect(screen.queryByTestId('state-panel-stale')).toBeNull();
    });

    it('user sees no chip, no reason and no mark on a fresh state', async () => {
      await renderPanelWith({ updatedAt: minutesBeforeNow(1) });

      expect(screen.queryByTestId('overdue-chip')).toBeNull();
      expect(screen.queryByTestId('state-panel-overdue-reason')).toBeNull();
      expect(screen.queryByTestId('state-panel-stale')).toBeNull();
    });
  });

  describe('when there is no state to show', () => {
    it('user reads that no state is recorded yet for an open session', async () => {
      await renderPanel({ states: [] });

      expect(screen.getByTestId('state-panel-none')).toHaveTextContent('No state recorded yet');
      expect(screen.queryByTestId('state-section-plan')).toBeNull();
    });

    it('user reads that the state is not shown for a closed session, not that none exists', async () => {
      await renderPanel({ states: [] }, sessionOf({ state: 'closed' }));

      expect(screen.getByTestId('state-panel-none')).toHaveTextContent('State not shown for a closed session');
    });

    it('user still reads the last state of a session that closed while the app was open', async () => {
      await renderPanel({ states: [stateOf({ plan: ['last plan'] })] }, sessionOf({ state: 'closed' }));

      expect(screen.getByTestId('state-section-plan')).toHaveTextContent('last plan');
    });

    it('user reads that this daemon does not report states, not that the session has none', async () => {
      await renderPanel({ states: [], reported: false });

      expect(screen.getByTestId('state-panel-none')).toHaveTextContent('State not reported by this daemon');
      expect(screen.queryByTestId('overdue-chip')).toBeNull();
    });
  });

  describe('with hostile data', () => {
    it('user sees "updated just now" and no chip for a state stamped in the future by clock skew', async () => {
      await renderPanel({ states: [stateOf({ updatedAt: minutesBeforeNow(-10) })] });

      expect(screen.getByTestId('state-panel-updated')).toHaveTextContent('updated just now');
      expect(screen.queryByTestId('overdue-chip')).toBeNull();
    });

    it('user is told the state time is unknown, never "NaN", when the state time cannot be read', async () => {
      await renderPanel({ states: [stateOf({ updatedAt: 'not a date' })] });

      expect(screen.getByTestId('state-panel-updated')).toHaveTextContent('updated time unknown');
      expect(screen.getByTestId('state-panel-overdue-reason')).toHaveTextContent('State time unknown');
      expect(screen.getByTestId('state-panel')).not.toHaveTextContent('NaN');
    });

    it('user reads a 300 character item without a space in full', async () => {
      const unbrokenItem = 'x'.repeat(300);
      await renderPanelWith({ plan: [unbrokenItem] });

      const item = within(screen.getByTestId('state-section-plan')).getByTestId('state-item');

      expect(item).toHaveTextContent(unbrokenItem);
      expect(item).toBeVisible();
    });

    it('user finds all the items of a state of 120 items', async () => {
      const twentyItems = (label: string) => Array.from({ length: 20 }, (_, index) => `${label} ${index}`);
      await renderPanelWith({
        plan: twentyItems('plan'), todo: twentyItems('todo'), remaining: twentyItems('remaining'),
        questionsForHuman: twentyItems('question'), internalQuestions: twentyItems('internal'), blockers: twentyItems('blocker'),
      });

      expect(screen.getAllByTestId('state-item')).toHaveLength(120);
    });
  });

  describe('with the keyboard', () => {
    it('user pressing Escape inside the panel changes nothing', async () => {
      await renderPanelWith({ plan: ['a'] });

      await userEvent.keyboard('{Escape}');

      expect(body()).not.toBeNull();
      expect(screen.getByTestId('state-section-plan')).toHaveTextContent('a');
    });
  });

  describe('when the user switches to another session', () => {
    it('user finds the panel showing the state of the new session', async () => {
      const first = sessionOf({ id: 's1' });
      const second = sessionOf({ id: 's2', name: 'Legolas' });
      const shown = signal(first);
      const events = fakeWorkingStateEvents({ sessions: [first, second], states: [stateOf({ sessionId: 's1', plan: ['first plan'] }), stateOf({ sessionId: 's2', plan: ['second plan'] })] });
      const { fixture } = await render(StatePanelComponent, {
        bindings: [inputBinding('session', shown)],
        providers: [{ provide: FleetEventsService, useValue: events }],
      });
      expect(screen.getByTestId('state-section-plan')).toHaveTextContent('first plan');

      shown.set(second);
      await fixture.whenStable();

      expect(screen.getByTestId('state-section-plan')).toHaveTextContent('second plan');
    });
  });
});
