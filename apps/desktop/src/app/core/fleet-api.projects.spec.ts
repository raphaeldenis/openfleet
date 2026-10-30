import { DEFAULT_ESCALATION_POLICY, type Project } from '@openfleet/shared';
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

    it('keeps the names of the projects that share the docs folder', async () => {
      const shared: Project = { ...FLEET, docsFolderSharedWith: ['Armada'] };
      answerWith(shared, 201);

      await expect(api.createProject({ name: 'Fleet', docsFolderPath: '/work/fleet-docs' })).resolves.toEqual(shared);
    });

    it('keeps the row guard warning of the project', async () => {
      const warned: Project = { ...FLEET, rowGuardWarning: 'The row guard does not check a status column that is not a select.' };
      answerWith(warned, 201);

      await expect(api.createProject({ name: 'Fleet', docsFolderPath: '/work/fleet-docs' })).resolves.toEqual(warned);
    });

    it('keeps the escalation policy of the project', async () => {
      const withPolicy: Project = { ...FLEET, escalation: { ...DEFAULT_ESCALATION_POLICY, humanClasses: ['contract', 'security', 'spend'] } };
      answerWith(withPolicy, 201);

      await expect(api.createProject({ name: 'Fleet' })).resolves.toEqual(withPolicy);
    });

    it('drops an escalation policy it cannot read instead of rejecting the project', async () => {
      answerWith({ ...FLEET, escalation: { humanClasses: ['banana'] } }, 201);

      await expect(api.createProject({ name: 'Fleet' })).resolves.toEqual(FLEET);
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

  describe('answerEscalation', () => {
    const answers = [{ question_id: 'q1', answer: 'Yes' }, { question_id: 'q2', answer: 'No' }];

    it('posts one answer per question to the escalation and returns the resolved escalation', async () => {
      const resolved = { id: 'e/1', status: 'answered' };
      answerWith(resolved);

      const result = await api.answerEscalation('e/1', { answers });

      expect(result).toEqual(resolved);
      expect(sentRequest()).toMatchObject({ method: 'POST', body: { answers } });
      expect(sentRequest().url).toMatch(/\/api\/escalations\/e%2F1\/answer$/);
    });

    it('rejects with the typed error of the daemon when the escalation was already answered', async () => {
      answerWith({ error: 'already_resolved' }, 409);

      await expect(api.answerEscalation('e1', { answers })).rejects.toMatchObject({ status: 409, code: 'already_resolved' });
    });
  });
});
