import type { ManagerProfile } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from './fleet-api.service';

function fakeResponse(init: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  return init as unknown as Response;
}

const PROFILE: ManagerProfile = {
  manager: { sessionId: 'm1', pulseSeconds: 600, childrenCap: 4, missionText: 'Ship it', nextPulseAt: '2026-10-05T10:00:00.000Z', childrenCount: 1 },
  scapeImport: 'as_imported',
};

describe('FleetApiService manager routes', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;
  const answerWith = (body: unknown, status = 200) =>
    fetchMock.mockResolvedValue(fakeResponse({ ok: status < 400, status, json: () => Promise.resolve(body) }));
  const sentRequest = () => {
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    return { url: String(url), method: init.method, body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown) };
  };

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  describe('getManagerProfile', () => {
    it('reads the manager with where it stands against a Scape re-import', async () => {
      answerWith(PROFILE);

      await expect(api.getManagerProfile('m1')).resolves.toEqual(PROFILE);
      expect(sentRequest().url).toMatch(/\/api\/managers\/m1$/);
    });

    it('rejects an answer that is not a manager profile', async () => {
      answerWith({ manager: { sessionId: 'm1' }, scapeImport: 'who knows' });

      await expect(api.getManagerProfile('m1')).rejects.toBeInstanceOf(ApiError);
    });

    it('rejects with the typed error of the daemon when the manager is gone', async () => {
      answerWith({ error: 'manager_not_found' }, 404);

      await expect(api.getManagerProfile('m1')).rejects.toMatchObject({ status: 404, code: 'manager_not_found' });
    });
  });

  describe('updateManager', () => {
    it('patches the given fields and returns the manager as it now is', async () => {
      answerWith(PROFILE.manager);

      const updated = await api.updateManager('m1', { childrenCap: 8, mission: 'New mission' });

      expect(updated).toEqual(PROFILE.manager);
      expect(sentRequest()).toMatchObject({ method: 'PATCH', body: { childrenCap: 8, mission: 'New mission' } });
      expect(sentRequest().url).toMatch(/\/api\/managers\/m1$/);
    });
  });

  describe('reopenSession', () => {
    it('asks for the mode it is given', async () => {
      answerWith({ id: 'm1' });

      await api.reopenSession('m1', 'fresh');

      expect(sentRequest()).toMatchObject({ method: 'POST', body: { mode: 'fresh' } });
    });

    it('resumes the previous conversation when no mode is given', async () => {
      answerWith({ id: 'm1' });

      await api.reopenSession('m1');

      expect(sentRequest()).toMatchObject({ body: { mode: 'resume' } });
    });
  });
});
