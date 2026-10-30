import { inputBinding, signal } from '@angular/core';
import { render, screen } from '@testing-library/angular/zoneless';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import type { TokenUsage } from '../core/token-usage';
import { SessionTokenUsageComponent } from './session-token-usage.component';

async function renderFor({ answers }: { answers: (TokenUsage | null | Error)[] }) {
  const getSessionUsage = vi.fn<(id: string) => Promise<TokenUsage | null>>();
  for (const answer of answers) {
    if (answer instanceof Error) getSessionUsage.mockRejectedValueOnce(answer);
    else getSessionUsage.mockResolvedValueOnce(answer);
  }
  const state = signal('generating');
  await render(SessionTokenUsageComponent, {
    bindings: [inputBinding('sessionId', () => 'gimli'), inputBinding('state', state)],
    providers: [{ provide: FleetApiService, useValue: { getSessionUsage } }],
  });
  return { getSessionUsage, state };
}

describe('SessionTokenUsageComponent', () => {
  it('asks the daemon for the session usage and shows it', async () => {
    const { getSessionUsage } = await renderFor({ answers: [{ inputTokens: 12_300, outputTokens: 4_100 }] });

    expect(await screen.findByText('12.3k in / 4.1k out')).toBeInTheDocument();
    expect(getSessionUsage).toHaveBeenCalledWith('gimli');
  });

  it('shows n/a when the daemon has no usage for the session', async () => {
    await renderFor({ answers: [null] });

    expect(await screen.findByText('n/a')).toBeInTheDocument();
  });

  it('shows an error, not n/a, when the request fails, never a stale or zero count', async () => {
    await renderFor({ answers: [new Error('daemon down')] });

    expect(await screen.findByText('error')).toBeInTheDocument();
    expect(screen.queryByText('n/a')).not.toBeInTheDocument();
  });

  it('asks again when the session changes state, since a turn has ended', async () => {
    const { getSessionUsage, state } = await renderFor({ answers: [{ inputTokens: 1, outputTokens: 1 }, { inputTokens: 2_000, outputTokens: 500 }] });
    await screen.findByText('1 in / 1 out');

    state.set('idle');

    await expect.poll(() => getSessionUsage.mock.calls.length).toBe(2);
    expect(await screen.findByText('2k in / 500 out')).toBeInTheDocument();
  });
});
