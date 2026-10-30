import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from './fleet-api.service';
import { SessionUsageService } from './session-usage.service';
import type { TokenUsage } from './token-usage';

type Answer = TokenUsage | null;

function newService() {
  const pendingAnswers: { resolve: (answer: Answer) => void; reject: (error: Error) => void }[] = [];
  const getSessionUsage = vi.fn(() => new Promise<Answer>((resolve, reject) => pendingAnswers.push({ resolve, reject })));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: FleetApiService, useValue: { getSessionUsage } }] });
  const answerNext = async (answer: Answer) => {
    pendingAnswers.shift()?.resolve(answer);
    await flushPromises();
  };
  return { service: TestBed.inject(SessionUsageService), getSessionUsage, pendingAnswers, answerNext };
}

const usage = (inputTokens: number): TokenUsage => ({ inputTokens, outputTokens: 0 });
const flushPromises = () => new Promise((resolve) => setTimeout(resolve));

describe('SessionUsageService', () => {
  it('holds the answer of the daemon for a session', async () => {
    const { service, answerNext } = newService();

    const refreshing = service.refresh('gimli');
    await answerNext(usage(10));
    await refreshing;

    expect(service.usageOf('gimli')()).toEqual(usage(10));
  });

  it('asks again once when refreshes are requested while one is in flight, and keeps the newest answer', async () => {
    const { service, getSessionUsage, answerNext } = newService();

    const firstRefresh = service.refresh('gimli');
    void service.refresh('gimli');
    void service.refresh('gimli');
    void service.refresh('gimli');
    await answerNext(usage(1));
    await answerNext(usage(2));
    await firstRefresh;

    expect(getSessionUsage).toHaveBeenCalledTimes(2);
    expect(service.usageOf('gimli')()).toEqual(usage(2));
  });

  it('does not ask again when no refresh was requested during the one in flight', async () => {
    const { service, getSessionUsage, answerNext } = newService();

    const refreshing = service.refresh('gimli');
    await answerNext(usage(1));
    await refreshing;
    await flushPromises();

    expect(getSessionUsage).toHaveBeenCalledTimes(1);
  });

  it('tells a failed request from an absence of data', async () => {
    const { service, pendingAnswers, answerNext } = newService();

    const failing = service.refresh('gimli');
    pendingAnswers.shift()?.reject(new Error('daemon down'));
    await failing;
    const empty = service.refresh('balin');
    await answerNext(null);
    await empty;

    expect(service.usageOf('gimli')()).toBe('unavailable');
    expect(service.usageOf('balin')()).toBeNull();
  });
});
