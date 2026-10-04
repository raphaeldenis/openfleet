import type { HandoffPreview, HandoffTarget } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from './fleet-api.service';

function fakeResponse(init: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  return init as unknown as Response;
}

const TARGET: HandoffTarget = { available: false, reason: 'no_project', writeOnCloseDefault: false };

const PREVIEW: HandoffPreview = {
  sessionId: 's1',
  kind: 'session',
  sections: { goal: 'Ship it', state: 'idle', decisions: '', filesTouched: ' M a.ts', nextSteps: '- one', openQuestions: '' },
  sources: { goal: 'none', state: 'session', decisions: 'none', filesTouched: 'git', nextSteps: 'working_state', openQuestions: 'none' },
  truncated: [],
  target: TARGET,
  generatedAt: '2026-10-04T10:00:00.000Z',
};

describe('FleetApiService handoff routes', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;
  const answerWith = (body: unknown) => fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(body) }));

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('reads the handoff preview of one session', async () => {
    answerWith(PREVIEW);

    await expect(api.getHandoffPreview('s1')).resolves.toEqual(PREVIEW);

    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/api\/sessions\/s1\/handoff-preview$/);
  });

  it('escapes the session id in the preview path', async () => {
    answerWith({ ...PREVIEW, sessionId: 'a/b' });

    await api.getHandoffPreview('a/b');

    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/sessions/a%2Fb/handoff-preview');
  });

  it('reads the handoff target of one session', async () => {
    answerWith(TARGET);

    await expect(api.getHandoffTarget('s1')).resolves.toEqual(TARGET);

    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/api\/sessions\/s1\/handoff-target$/);
  });

  it.each([
    ['a body that is not an object', 'nope'],
    ['sections with a missing field', { ...PREVIEW, sections: { goal: 'x' } }],
    ['sections with an unknown field', { ...PREVIEW, sections: { ...PREVIEW.sections, extra: 'x' } }],
    ['an unknown kind', { ...PREVIEW, kind: 'team' }],
    ['a source this app does not know', { ...PREVIEW, sources: { ...PREVIEW.sources, goal: 'telepathy' } }],
    ['a missing target', { ...PREVIEW, target: undefined }],
    ['a target without its availability', { ...PREVIEW, target: { writeOnCloseDefault: false } }],
  ])('rejects a preview with %s', async (_label, body) => {
    answerWith(body);

    await expect(api.getHandoffPreview('s1')).rejects.toBeInstanceOf(ApiError);
  });

  it.each([
    ['an unknown reason', { available: false, reason: 'because', writeOnCloseDefault: false }],
    ['a non-boolean availability', { available: 'yes', writeOnCloseDefault: false }],
    ['a non-string path', { available: true, relativePath: 3, writeOnCloseDefault: true }],
  ])('rejects a target with %s', async (_label, body) => {
    answerWith(body);

    await expect(api.getHandoffTarget('s1')).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects with the error envelope of the daemon when the session is unknown', async () => {
    const envelope = { error: 'session_not_found', kind: 'not_found', retry: 'never', message: 'No such session.' };
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 404, json: () => Promise.resolve(envelope) }));

    const failure = await api.getHandoffPreview('nope').catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 404, code: 'session_not_found', envelope });
  });
});
