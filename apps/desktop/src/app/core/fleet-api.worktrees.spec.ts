import type { WorktreeEntry } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from './fleet-api.service';

const PROJECT_ID = '3f2b8c1e-5d4a-4b6e-9a7c-1d2e3f4a5b6c';
const WORKTREE: WorktreeEntry = {
  repoPath: '/src/fleet', path: '/home/.openfleet/worktrees/t1', branch: 't1/api', head: 'abc1234', isMain: false, isDetached: false, isLocked: false,
  isPrunable: false, isDirty: false, isInUse: false, isUnderWorktreesRoot: true, removable: true,
};

const fakeResponse = (init: { ok: boolean; status: number; json: () => Promise<unknown> }) => init as unknown as Response;

describe('FleetApiService worktree routes', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;
  const answerWith = (body: unknown, status = 200) => fetchMock.mockResolvedValue(fakeResponse({ ok: status < 400, status, json: () => Promise.resolve(body) }));
  const sentRequest = () => {
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    return { url: String(url), method: init.method ?? 'GET' };
  };

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lists the worktrees of a project', async () => {
    answerWith({ items: [WORKTREE], total: 1 });

    const list = await api.listWorktrees(PROJECT_ID);

    expect(list.items).toEqual([WORKTREE]);
    expect(sentRequest()).toEqual({ url: expect.stringMatching(new RegExp(`/api/projects/${PROJECT_ID}/worktrees$`)), method: 'GET' });
  });

  it('refuses an answer that is not a list of worktrees', async () => {
    answerWith({ nothing: true });

    await expect(api.listWorktrees(PROJECT_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it('removes a worktree by its path, encoded in the query, and returns what the daemon removed', async () => {
    answerWith({ removed: WORKTREE.path, branch: 't1/api', ignoredFileCount: 3 });

    const removed = await api.removeWorktree(PROJECT_ID, '/home/.openfleet/worktrees/a b&c');

    expect(removed).toEqual({ removed: WORKTREE.path, branch: 't1/api', ignoredFileCount: 3 });
    expect(sentRequest()).toEqual({ url: expect.stringContaining('/worktrees?path=%2Fhome%2F.openfleet%2Fworktrees%2Fa+b%26c'), method: 'DELETE' });
  });

  it('keeps the post-create hook of a project the daemon returns', async () => {
    answerWith({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, postCreateHookScript: '/hooks/setup.sh', postCreateHookTimeoutSeconds: 90 });

    const project = await api.updateProject(PROJECT_ID, { postCreateHookScript: '/hooks/setup.sh', postCreateHookTimeoutSeconds: 90 });

    expect(project).toEqual({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, postCreateHookScript: '/hooks/setup.sh', postCreateHookTimeoutSeconds: 90 });
  });

  it('returns a project without hook fields when the daemon sends none', async () => {
    answerWith({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null });

    expect(await api.updateProject(PROJECT_ID, { name: 'Fleet' })).toEqual({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null });
  });
});
