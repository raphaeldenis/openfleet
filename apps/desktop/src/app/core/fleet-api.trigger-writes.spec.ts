import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from './fleet-api.service';

describe('FleetApiService: trigger writes', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const lastRequest = () => {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as unknown };
  };

  it('arms with the approved revision as the whole body and the proof of the human gesture in a header', async () => {
    await TestBed.inject(FleetApiService).armTrigger({ triggerId: 't 1', approvedRev: 4, humanProof: 'nonce-1' });

    const { url, init, headers, body } = lastRequest();
    expect(url).toMatch(/\/api\/triggers\/t%201\/arm$/);
    expect(init.method).toBe('POST');
    expect(headers['x-human-proof']).toBe('nonce-1');
    expect(body).toEqual({ approvedRev: 4 });
  });

  it('keeps the admin authorisation next to the proof', async () => {
    await TestBed.inject(FleetApiService).armTrigger({ triggerId: 't1', approvedRev: 4, humanProof: 'nonce-1' });

    expect(lastRequest().headers['authorization']).toMatch(/^Bearer /);
  });

  it('disarms with a POST and no proof', async () => {
    await TestBed.inject(FleetApiService).disarmTrigger('t1');

    const { url, init, headers } = lastRequest();
    expect(url).toMatch(/\/api\/triggers\/t1\/disarm$/);
    expect(init.method).toBe('POST');
    expect(headers['x-human-proof']).toBeUndefined();
  });

  it('replaces the title and the policy against the revision read', async () => {
    const policy = { cooldownSeconds: 5, batchMode: 'per_event', backlogPolicy: 'fire_all' } as const;

    await TestBed.inject(FleetApiService).updateTrigger({ triggerId: 't1', expectedRev: 2, changes: { title: 'Autre', policy } });

    const { url, init, body } = lastRequest();
    expect(url).toMatch(/\/api\/triggers\/t1$/);
    expect(init.method).toBe('PUT');
    expect(body).toEqual({ expectedRev: 2, title: 'Autre', policy });
  });
});
