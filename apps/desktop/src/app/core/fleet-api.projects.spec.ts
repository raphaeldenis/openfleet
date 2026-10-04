import type { Project } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from './fleet-api.service';

function fakeResponse(init: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  return init as unknown as Response;
}

const FLEET: Project = { id: '3f2b8c1e-5d4a-4b6e-9a7c-1d2e3f4a5b6c', name: 'Fleet', docsFolderPath: '/work/fleet-docs' };

describe('FleetApiService project routes', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;
  const answerWith = (body: unknown, status = 200) =>
    fetchMock.mockResolvedValue(fakeResponse({ ok: status < 400, status, json: () => Promise.resolve(body) }));
  const sentRequest = () => {
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    return { url: String(url), method: init.method, body: JSON.parse(String(init.body)) as unknown };
  };

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  describe('createProject', () => {
    it('posts the name and the docs folder, and returns the project the daemon created', async () => {
      answerWith(FLEET, 201);

      const created = await api.createProject({ name: 'Fleet', docsFolderPath: '/work/fleet-docs' });

      expect(created).toEqual(FLEET);
      expect(sentRequest()).toMatchObject({ method: 'POST', body: { name: 'Fleet', docsFolderPath: '/work/fleet-docs' } });
      expect(sentRequest().url).toMatch(/\/api\/projects$/);
    });

    it('accepts a project without a docs folder', async () => {
      const withoutFolder: Project = { ...FLEET, docsFolderPath: null };
      answerWith(withoutFolder, 201);

      await expect(api.createProject({ name: 'Fleet' })).resolves.toEqual(withoutFolder);
    });

    it('rejects with the typed error of the daemon when the folder is refused', async () => {
      answerWith({ error: 'docs_folder_not_writable' }, 400);

      await expect(api.createProject({ name: 'Fleet', docsFolderPath: '/ro' })).rejects.toMatchObject({ status: 400, code: 'docs_folder_not_writable' });
    });

    it.each([
      ['a body that is not an object', 'nope'],
      ['a project without an id', { name: 'Fleet', docsFolderPath: null }],
      ['a project whose name is not text', { ...FLEET, name: 7 }],
      ['a project whose docs folder is neither text nor null', { ...FLEET, docsFolderPath: 7 }],
    ])('rejects %s as an unreadable project', async (_label, body) => {
      answerWith(body, 201);

      await expect(api.createProject({ name: 'Fleet' })).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('updateProject', () => {
    it('patches the project with only the fields given, and returns the updated project', async () => {
      answerWith(FLEET);

      const updated = await api.updateProject(FLEET.id, { docsFolderPath: '/work/fleet-docs' });

      expect(updated).toEqual(FLEET);
      expect(sentRequest()).toMatchObject({ method: 'PATCH', body: { docsFolderPath: '/work/fleet-docs' } });
      expect(sentRequest().url).toMatch(new RegExp(`/api/projects/${FLEET.id}$`));
    });

    it('escapes the project id in the path', async () => {
      answerWith(FLEET);

      await api.updateProject('a/b', { name: 'Fleet' });

      expect(sentRequest().url).toContain('/api/projects/a%2Fb');
    });

    it('rejects an answer that is not a project', async () => {
      answerWith({ ok: true });

      await expect(api.updateProject(FLEET.id, { name: 'Fleet' })).rejects.toBeInstanceOf(ApiError);
    });
  });
});
