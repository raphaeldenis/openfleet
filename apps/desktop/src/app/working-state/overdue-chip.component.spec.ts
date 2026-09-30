import { inputBinding } from '@angular/core';
import { render, screen } from '@testing-library/angular/zoneless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, WorkingState } from '@openfleet/shared';
import { FleetEventsService } from '../core/fleet-events.service';
import { OverdueChipComponent } from './overdue-chip.component';
import { NOW_ISO, fakeWorkingStateEvents, minutesBeforeNow, sessionOf, stateOf } from './working-state-fixtures';

const chip = () => screen.queryByTestId('overdue-chip');

async function renderChip(options: Parameters<typeof fakeWorkingStateEvents>[0] = {}, session: Session = sessionOf()) {
  const events = fakeWorkingStateEvents({ sessions: [session], ...options });
  const view = await render(OverdueChipComponent, {
    bindings: [inputBinding('session', () => session)],
    providers: [{ provide: FleetEventsService, useValue: events }],
  });
  return { ...view, events };
}

// Sizes worked out by hand from the mirror format (6 headings, "- " items, "(rien)" for an empty section):
// an empty state is 142 bytes, each non-empty section drops 7 and each item adds 3 + its length.
const itemsOf = (length: number, count: number, character = 'x') => Array.from({ length: count }, () => character.repeat(length));
const stateOfExactlyBytes = (bytes: 6144 | 6145): WorkingState =>
  stateOf({ plan: itemsOf(300, 19), todo: itemsOf(bytes === 6144 ? 256 : 257, 1) });

describe('OverdueChipComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => vi.useRealTimers());

  it('user sees "state overdue" on an open session that has no state', async () => {
    await renderChip({ states: [] });

    expect(chip()).toHaveTextContent('state overdue');
    expect(chip()).toHaveAttribute('data-reason', 'missing');
  });

  it.each(['idle', 'generating', 'starting', 'waiting_input', 'waiting_permission'] as const)('user sees the chip on a %s session with no state', async (state) => {
    await renderChip({ states: [] }, sessionOf({ state }));

    expect(chip()).not.toBeNull();
  });

  it('user sees no chip on a closed session, whatever its state', async () => {
    await renderChip({ states: [] }, sessionOf({ state: 'closed' }));

    expect(chip()).toBeNull();
  });

  it('user sees no chip when the daemon does not report working states', async () => {
    await renderChip({ states: [], reported: false });

    expect(chip()).toBeNull();
  });

  it('user sees no chip on a session whose state is fresh', async () => {
    await renderChip({ states: [stateOf({ updatedAt: minutesBeforeNow(1) })] });

    expect(chip()).toBeNull();
  });

  it.each([
    ['29 minutes old', 29, false],
    ['exactly 30 minutes old', 30, false],
    ['31 minutes old', 31, true],
  ])('user sees the chip only past the limit: a state %s with a 30 minute limit', async (_label, ageMinutes, isOverdue) => {
    await renderChip({ states: [stateOf({ updatedAt: minutesBeforeNow(ageMinutes) })] });

    expect(chip() !== null).toBe(isOverdue);
    if (isOverdue) expect(chip()).toHaveAttribute('data-reason', 'too_old');
  });

  it('user sees the limit the daemon reports, not a fixed one', async () => {
    await renderChip({ states: [stateOf({ updatedAt: minutesBeforeNow(6) })], maxAgeMinutes: 5 });

    expect(chip()).toHaveAttribute('data-reason', 'too_old');
  });

  it('user sees no age check when the daemon does not report a limit', async () => {
    await renderChip({ states: [stateOf({ updatedAt: minutesBeforeNow(60 * 24 * 10) })], maxAgeMinutes: undefined });

    expect(chip()).toBeNull();
  });

  it('user sees the chip on a state written before the last spawn or close', async () => {
    await renderChip({ states: [stateOf({ updatedAt: minutesBeforeNow(2), fleetChangedAt: minutesBeforeNow(1) })] });

    expect(chip()).toHaveAttribute('data-reason', 'fleet_changed');
  });

  it.each([
    ['at the same instant', minutesBeforeNow(2), minutesBeforeNow(2)],
    ['before the state', minutesBeforeNow(2), minutesBeforeNow(3)],
  ])('user sees no chip when the fleet changed %s as the state was written', async (_label, updatedAt, fleetChangedAt) => {
    await renderChip({ states: [stateOf({ updatedAt, fleetChangedAt })] });

    expect(chip()).toBeNull();
  });

  it('user sees no chip on a state of exactly 6144 bytes', async () => {
    await renderChip({ states: [stateOfExactlyBytes(6144)] });
    expect(chip()).toBeNull();
  });

  it('user sees the chip on a state one byte over the size limit', async () => {
    await renderChip({ states: [stateOfExactlyBytes(6145)] });

    expect(chip()).toHaveAttribute('data-reason', 'oversize');
  });

  it('user sees the size counted in bytes: accented characters count for two', async () => {
    const tenLinesOf300Accents = itemsOf(300, 10, 'é');

    await renderChip({ states: [stateOf({ plan: tenLinesOf300Accents })] });

    expect(chip()).toHaveAttribute('data-reason', 'oversize');
  });

  it('user sees the size limit the daemon reports, not a fixed one', async () => {
    await renderChip({ states: [stateOf({ plan: ['a short plan line'] })], maxBytes: 150 });

    expect(chip()).toHaveAttribute('data-reason', 'oversize');
  });

  it('user sees no size check when the daemon does not report a size limit', async () => {
    await renderChip({ states: [stateOfExactlyBytes(6145)], maxBytes: undefined });

    expect(chip()).toBeNull();
  });

  it.each([
    ['missing', {}, 'No state recorded'],
    ['too_old', { updatedAt: minutesBeforeNow(31) }, 'Written 31 minutes ago, limit 30 minutes'],
    ['fleet_changed', { updatedAt: minutesBeforeNow(2), fleetChangedAt: minutesBeforeNow(1) }, 'Written before the last spawn or close'],
  ])('user can read why the state is overdue (%s) in the chip title', async (reason, patch, expected) => {
    const states = reason === 'missing' ? [] : [stateOf(patch)];

    await renderChip({ states });

    expect(chip()).toHaveAttribute('title', expected);
    expect(chip()).toHaveAttribute('aria-label', `state overdue: ${expected}`);
  });

  it('user sees the chip appear when time passes the limit, without a new event', async () => {
    const { fixture } = await renderChip({ states: [stateOf({ updatedAt: minutesBeforeNow(29) })] });
    expect(chip()).toBeNull();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await fixture.whenStable();

    expect(chip()).toHaveAttribute('data-reason', 'too_old');
  });

  it('user sees the chip leave when the session writes a fresh state', async () => {
    const { fixture, events } = await renderChip({ states: [stateOf({ updatedAt: minutesBeforeNow(40) })] });
    expect(chip()).not.toBeNull();

    events.workingStates.set(new Map([['s1', stateOf({ updatedAt: minutesBeforeNow(0) })]]));
    await fixture.whenStable();

    expect(chip()).toBeNull();
  });
});
