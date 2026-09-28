import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from './fleet-api.service';

function stubFetchReturning(session: { id: string }) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => session });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const [, init] = fetchMock.mock.calls[0]!;
  return JSON.parse(init.body as string);
}

describe('FleetApiService.createManagerSession', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the harness and permission mode next to the nested manager spec', async () => {
    const fetchMock = stubFetchReturning({ id: 'm-1' });

    await new FleetApiService().createManagerSession({
      directory: '/tmp/wt', name: 'Lead', emoji: '🧭', model: 'opus', harness: 'claude-cli', permissionMode: 'plan',
      pulseSeconds: 900, childrenCap: 4, mission: 'Ship it',
    });

    expect(postedBody(fetchMock)).toEqual({
      directory: '/tmp/wt', name: 'Lead', emoji: '🧭', model: 'opus', harness: 'claude-cli', permissionMode: 'plan',
      manager: { pulseSeconds: 900, childrenCap: 4, mission: 'Ship it' },
    });
  });

  it('posts no permission mode when none is chosen', async () => {
    const fetchMock = stubFetchReturning({ id: 'm-1' });

    await new FleetApiService().createManagerSession({
      directory: '/tmp/wt', name: 'Lead', pulseSeconds: 900, childrenCap: 4, mission: 'Ship it',
    });

    expect(postedBody(fetchMock)).not.toHaveProperty('permissionMode');
  });
});
