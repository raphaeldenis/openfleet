import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from './fleet-api.service';
import { ProjectUsageService } from './project-usage.service';
import type { TokenUsage } from './token-usage';

type Answer = TokenUsage | null;

function newService() {
  const pendingAnswers: { resolve: (answer: Answer) => void; reject: (error: Error) => void }[] = [];
  const getProjectUsageToday = vi.fn(() => new Promise<Answer>((resolve, reject) => pendingAnswers.push({ resolve, reject })));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: FleetApiService, useValue: { getProjectUsageToday } }] });
  const answerNext = async (answer: Answer) => {
    pendingAnswers.shift()?.resolve(answer);
    await flushPromises();
  };
  return { service: TestBed.inject(ProjectUsageService), getProjectUsageToday, pendingAnswers, answerNext };
}

const usage = (inputTokens: number): TokenUsage => ({ inputTokens, outputTokens: 0 });
const flushPromises = () => new Promise((resolve) => setTimeout(resolve));

describe('ProjectUsageService', () => {
  it('waits for the first answer before holding anything', () => {
    const { service } = newService();

    expect(service.todayOf('p1')()).toBeUndefined();
  });

  it('holds the answer of the daemon for a project', async () => {
    const { service, answerNext } = newService();

    const refreshing = service.refresh('p1');
    await answerNext(usage(10));
    await refreshing;

    expect(service.todayOf('p1')()).toEqual(usage(10));
  });

  it('keeps the usage of each project apart', async () => {
    const { service, answerNext } = newService();

    const first = service.refresh('p1');
    await answerNext(usage(10));
    await first;
    const second = service.refresh('p2');
    await answerNext(usage(20));
    await second;

    expect(service.todayOf('p1')()).toEqual(usage(10));
    expect(service.todayOf('p2')()).toEqual(usage(20));
  });

  it('asks again once when refreshes are requested while one is in flight, and keeps the newest answer', async () => {
    const { service, getProjectUsageToday, answerNext } = newService();

    const firstRefresh = service.refresh('p1');
    void service.refresh('p1');
    void service.refresh('p1');
    void service.refresh('p1');
    await answerNext(usage(1));
    await answerNext(usage(2));
    await firstRefresh;

    expect(getProjectUsageToday).toHaveBeenCalledTimes(2);
    expect(service.todayOf('p1')()).toEqual(usage(2));
  });

  it('does not ask again when no refresh was requested during the one in flight', async () => {
    const { service, getProjectUsageToday, answerNext } = newService();

    const refreshing = service.refresh('p1');
    await answerNext(usage(1));
    await refreshing;
    await flushPromises();

    expect(getProjectUsageToday).toHaveBeenCalledTimes(1);
  });

  it('tells a failed request from an absence of data', async () => {
    const { service, pendingAnswers, answerNext } = newService();

    const failing = service.refresh('p1');
    pendingAnswers.shift()?.reject(new Error('daemon down'));
    await failing;
    const empty = service.refresh('p2');
    await answerNext(null);
    await empty;

    expect(service.todayOf('p1')()).toBe('unavailable');
    expect(service.todayOf('p2')()).toBeNull();
  });
});
