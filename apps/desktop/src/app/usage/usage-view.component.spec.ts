import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import type { UsageDailyRow } from '../core/usage-daily-parser';
import { UsageViewComponent } from './usage-view.component';

const bucket = (overrides: Partial<UsageDailyRow> = {}): UsageDailyRow => ({
  dayUtc: '2026-10-30',
  model: 'opus',
  sessionId: 's1',
  billingCode: 'general',
  biller: 'api',
  costStatus: 'reported',
  messageCount: 1,
  inputTokens: 1_200,
  outputTokens: 340,
  cacheReadInputTokens: 9_000,
  cacheCreationInputTokens: 500,
  costUsd: 0.42,
  ...overrides,
});

interface DayRange { fromDayUtc: string; toDayUtc: string }

async function renderUsage(getDailyUsage: (range: DayRange) => Promise<UsageDailyRow[]>) {
  const api = { getDailyUsage: vi.fn(getDailyUsage) };
  await render(UsageViewComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
  return api;
}

describe('UsageViewComponent', () => {
  it('shows a loading state until the daemon answers', async () => {
    await renderUsage(() => new Promise(() => undefined));

    expect(screen.getByTestId('usage-loading')).toBeInTheDocument();
  });

  it('lists one row per day with in, out, cache and cost, summing models and sessions', async () => {
    await renderUsage(() => Promise.resolve([bucket(), bucket({ sessionId: 's2', model: 'sonnet', inputTokens: 800, costUsd: 0.1 })]));

    const row = await screen.findByTestId('usage-day-2026-10-30');
    expect(row).toHaveTextContent('2026-10-30');
    expect(row).toHaveTextContent('2,000');
    expect(row).toHaveTextContent('680');
    expect(row).toHaveTextContent('18,000');
    expect(row).toHaveTextContent('1,000');
    expect(row).toHaveTextContent('$0.52');
  });

  it('shows n/a for the cost of a day with no priced usage', async () => {
    await renderUsage(() => Promise.resolve([bucket({ costStatus: 'unpriced', costUsd: null })]));

    expect(await screen.findByTestId('usage-day-2026-10-30')).toHaveTextContent('n/a');
  });

  it('hides the model rows until the user asks for the breakdown by model', async () => {
    await renderUsage(() => Promise.resolve([bucket(), bucket({ model: 'haiku', inputTokens: 7 })]));
    await screen.findByTestId('usage-day-2026-10-30');
    expect(screen.queryByTestId('usage-model-2026-10-30-haiku')).toBeNull();

    await userEvent.click(screen.getByRole('checkbox', { name: /by model/i }));

    expect(within(screen.getByTestId('usage-model-2026-10-30-haiku')).getByText('haiku')).toBeInTheDocument();
    expect(screen.getByTestId('usage-model-2026-10-30-opus')).toBeInTheDocument();
  });

  it('explains that ingestion must be enabled when there is no usage', async () => {
    await renderUsage(() => Promise.resolve([]));

    const empty = await screen.findByTestId('usage-empty');
    expect(empty).toHaveTextContent('No usage yet');
    expect(empty).toHaveTextContent('Usage ingestion is off by default');
    expect(empty).toHaveTextContent('OPENFLEET_USAGE_INGESTION=1');
  });

  it('tells the user usage is unavailable and reads again on Retry', async () => {
    let attempts = 0;
    const api = await renderUsage(() => (++attempts === 1 ? Promise.reject(new Error('boom')) : Promise.resolve([bucket()])));
    expect(await screen.findByTestId('usage-error')).toHaveTextContent('Usage unavailable');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('usage-day-2026-10-30')).toBeInTheDocument();
    expect(api.getDailyUsage).toHaveBeenCalledTimes(2);
  });

  it('asks for a wider span of days when the user picks 30 days', async () => {
    const api = await renderUsage(() => Promise.resolve([]));
    await screen.findByTestId('usage-empty');

    await userEvent.click(screen.getByRole('button', { name: '30 days' }));

    const lastRequest = api.getDailyUsage.mock.calls.at(-1)![0];
    const spanInDays = (Date.parse(lastRequest.toDayUtc) - Date.parse(lastRequest.fromDayUtc)) / 86_400_000;
    expect(spanInDays).toBe(29);
  });

  it('marks the picked range as pressed', async () => {
    await renderUsage(() => Promise.resolve([]));

    await userEvent.click(screen.getByRole('button', { name: 'Today' }));

    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'false');
  });
});
