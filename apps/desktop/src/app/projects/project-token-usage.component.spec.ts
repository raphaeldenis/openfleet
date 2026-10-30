import { inputBinding, signal } from '@angular/core';
import { render, screen } from '@testing-library/angular/zoneless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import type { TokenUsage } from '../core/token-usage';
import { ProjectTokenUsageComponent } from './project-token-usage.component';

type Answer = TokenUsage | null | Error;

async function renderFor({ answers }: { answers: Answer[] }) {
  const getProjectUsageToday = vi.fn<(projectId: string) => Promise<TokenUsage | null>>();
  for (const answer of answers) {
    if (answer instanceof Error) getProjectUsageToday.mockRejectedValueOnce(answer);
    else getProjectUsageToday.mockResolvedValueOnce(answer);
  }
  const projectId = signal('p1');
  const sessionStates = signal('s1:generating');
  const { fixture } = await render(ProjectTokenUsageComponent, {
    bindings: [inputBinding('projectId', projectId), inputBinding('sessionStates', sessionStates)],
    providers: [{ provide: FleetApiService, useValue: { getProjectUsageToday } }],
  });
  return { fixture, getProjectUsageToday, projectId, sessionStates };
}

describe('ProjectTokenUsageComponent', () => {
  it('shows the tokens of the project today with the daemon counts', async () => {
    const { getProjectUsageToday } = await renderFor({ answers: [{ inputTokens: 12_300, outputTokens: 4_100 }] });

    expect(await screen.findByText('12.3k in / 4.1k out')).toBeInTheDocument();
    expect(getProjectUsageToday).toHaveBeenCalledWith('p1');
  });

  it('labels the figure Today (UTC) and explains the cut at 00:00 UTC in a title', async () => {
    await renderFor({ answers: [{ inputTokens: 1, outputTokens: 1 }] });

    expect(await screen.findByText('Today (UTC)')).toBeInTheDocument();
    expect(screen.getByTitle('Tokens used by this project since 00:00 UTC')).toBeInTheDocument();
  });

  it('shows … while the first answer is awaited', async () => {
    const getProjectUsageToday = vi.fn(() => new Promise<TokenUsage | null>(() => undefined));
    await render(ProjectTokenUsageComponent, {
      bindings: [inputBinding('projectId', () => 'p1'), inputBinding('sessionStates', () => '')],
      providers: [{ provide: FleetApiService, useValue: { getProjectUsageToday } }],
    });

    expect(screen.getByText('…')).toBeInTheDocument();
  });

  it('shows n/a when no session of the project has usage today', async () => {
    await renderFor({ answers: [null] });

    expect(await screen.findByText('n/a')).toBeInTheDocument();
  });

  it('shows a real zero as zero, apart from n/a', async () => {
    await renderFor({ answers: [{ inputTokens: 0, outputTokens: 0 }] });

    expect(await screen.findByText('0 in / 0 out')).toBeInTheDocument();
    expect(screen.queryByText('n/a')).not.toBeInTheDocument();
  });

  it('shows a very large count in billions with the exact figure in the label', async () => {
    await renderFor({ answers: [{ inputTokens: 2_345_678_901, outputTokens: 999_999_999_999 }] });

    expect(await screen.findByText('2.3B in / 1000B out')).toBeInTheDocument();
    expect(screen.getByLabelText('2,345,678,901 input tokens, 999,999,999,999 output tokens')).toBeInTheDocument();
  });

  it('shows an error, not n/a, when the request fails', async () => {
    await renderFor({ answers: [new Error('daemon down')] });

    expect(await screen.findByText('error')).toBeInTheDocument();
    expect(screen.queryByText('n/a')).not.toBeInTheDocument();
  });

  it('asks again when a session of the project changes state, since a turn has ended', async () => {
    const { getProjectUsageToday, sessionStates } = await renderFor({ answers: [{ inputTokens: 1, outputTokens: 1 }, { inputTokens: 2_000, outputTokens: 500 }] });
    await screen.findByText('1 in / 1 out');

    sessionStates.set('s1:idle');

    await expect.poll(() => getProjectUsageToday.mock.calls.length).toBe(2);
    expect(await screen.findByText('2k in / 500 out')).toBeInTheDocument();
  });

  it('reads the new project when the current project changes', async () => {
    const { getProjectUsageToday, projectId } = await renderFor({ answers: [{ inputTokens: 1, outputTokens: 1 }, { inputTokens: 7, outputTokens: 3 }] });
    await screen.findByText('1 in / 1 out');

    projectId.set('p2');

    await expect.poll(() => getProjectUsageToday.mock.calls.map(([id]) => id)).toEqual(['p1', 'p2']);
    expect(await screen.findByText('7 in / 3 out')).toBeInTheDocument();
  });

  it('keeps the answer of a project when a late answer of the previous project arrives', async () => {
    let answerP1: (usage: TokenUsage | null) => void = () => undefined;
    const lateAnswerOfP1 = new Promise<TokenUsage | null>((resolve) => (answerP1 = resolve));
    const getProjectUsageToday = vi.fn((projectId: string) =>
      projectId === 'p1' ? lateAnswerOfP1 : Promise.resolve<TokenUsage | null>({ inputTokens: 7, outputTokens: 3 }),
    );
    const projectId = signal('p1');
    await render(ProjectTokenUsageComponent, {
      bindings: [inputBinding('projectId', projectId), inputBinding('sessionStates', () => '')],
      providers: [{ provide: FleetApiService, useValue: { getProjectUsageToday } }],
    });
    projectId.set('p2');
    await screen.findByText('7 in / 3 out');

    answerP1({ inputTokens: 1, outputTokens: 1 });

    await new Promise((resolve) => setTimeout(resolve));
    expect(screen.getByText('7 in / 3 out')).toBeInTheDocument();
    expect(screen.queryByText('1 in / 1 out')).not.toBeInTheDocument();
  });

  describe('every minute while the page is visible', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('asks again after 60 seconds, not before', async () => {
      const { getProjectUsageToday } = await renderFor({ answers: [{ inputTokens: 1, outputTokens: 1 }, { inputTokens: 2, outputTokens: 2 }] });
      await expect.poll(() => getProjectUsageToday.mock.calls.length).toBe(1);

      vi.advanceTimersByTime(59_000);
      expect(getProjectUsageToday).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1_000);

      await expect.poll(() => getProjectUsageToday.mock.calls.length).toBe(2);
    });

    it('does not ask while the page is hidden', async () => {
      const { getProjectUsageToday } = await renderFor({ answers: [{ inputTokens: 1, outputTokens: 1 }] });
      await expect.poll(() => getProjectUsageToday.mock.calls.length).toBe(1);
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

      vi.advanceTimersByTime(180_000);

      expect(getProjectUsageToday).toHaveBeenCalledTimes(1);
    });

    it('asks again at once when the page becomes visible again, and not while it becomes hidden', async () => {
      const { getProjectUsageToday } = await renderFor({ answers: [{ inputTokens: 1, outputTokens: 1 }, { inputTokens: 2, outputTokens: 2 }] });
      await expect.poll(() => getProjectUsageToday.mock.calls.length).toBe(1);
      const visibilityState = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

      document.dispatchEvent(new Event('visibilitychange'));
      expect(getProjectUsageToday).toHaveBeenCalledTimes(1);
      visibilityState.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      await expect.poll(() => getProjectUsageToday.mock.calls.length).toBe(2);
    });

    it('stops asking once the component is destroyed', async () => {
      const { fixture, getProjectUsageToday } = await renderFor({ answers: [{ inputTokens: 1, outputTokens: 1 }] });
      await expect.poll(() => getProjectUsageToday.mock.calls.length).toBe(1);

      fixture.destroy();
      vi.advanceTimersByTime(180_000);
      document.dispatchEvent(new Event('visibilitychange'));

      expect(getProjectUsageToday).toHaveBeenCalledTimes(1);
    });
  });
});
