import type { HandoffPreview } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../core/fleet-api.service';
import { HandoffPreviewApiError } from './handoff-preview.api';
import { createHandoffPreviewApi } from './handoff-preview.adapter';

const SECTIONS = { goal: '', state: 'idle', decisions: '', filesTouched: '', nextSteps: '', openQuestions: '' };

const PREVIEW: HandoffPreview = {
  sessionId: 's1',
  kind: 'session',
  sections: SECTIONS,
  sources: { goal: 'none', state: 'session', decisions: 'none', filesTouched: 'none', nextSteps: 'none', openQuestions: 'none' },
  truncated: [],
  target: { available: false, reason: 'no_project', writeOnCloseDefault: false },
  generatedAt: '2026-10-04T10:00:00.000Z',
};

function envelopeError(code: string, status: number, retry: 'never' | 'later') {
  const kind = status === 404 ? 'not_found' : 'conflict';
  return new ApiError(status, 'GET /x', code, { error: code, kind, retry, message: 'raw' } as never);
}

describe('createHandoffPreviewApi', () => {
  it('reads the preview from the daemon route', async () => {
    const fleetApi = { getHandoffPreview: vi.fn().mockResolvedValue(PREVIEW), saveHandoff: vi.fn() };

    const preview = await createHandoffPreviewApi(fleetApi).getPreview('s1');

    expect(preview).toBe(PREVIEW);
    expect(fleetApi.getHandoffPreview).toHaveBeenCalledWith('s1');
  });

  it('fails with the copy of the error table when the session is unknown', async () => {
    const fleetApi = { getHandoffPreview: vi.fn().mockRejectedValue(envelopeError('session_not_found', 404, 'never')), saveHandoff: vi.fn() };

    const failure = await createHandoffPreviewApi(fleetApi).getPreview('s1').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HandoffPreviewApiError);
    expect(failure).toMatchObject({ copy: 'That session no longer exists.' });
  });

  it('fails with the connection copy when the daemon cannot be reached', async () => {
    const fleetApi = { getHandoffPreview: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), saveHandoff: vi.fn() };

    const failure = await createHandoffPreviewApi(fleetApi).getPreview('s1').catch((error: unknown) => error);

    expect(failure).toMatchObject({ copy: 'The preview could not be loaded — check your connection, then try again.' });
  });

  it('saves the edited sections through the daemon and returns where the file was written', async () => {
    const fleetApi = { getHandoffPreview: vi.fn(), saveHandoff: vi.fn().mockResolvedValue({ relativePath: 'handoffs/2026-10-04-gimli.md' }) };
    const editedSections = { ...SECTIONS, goal: 'Ship the save' };

    const saved = await createHandoffPreviewApi(fleetApi).save('s1', editedSections);

    expect(saved).toEqual({ relativePath: 'handoffs/2026-10-04-gimli.md' });
    expect(fleetApi.saveHandoff).toHaveBeenCalledWith('s1', editedSections);
  });

  it.each([
    ['docs_folder_not_writable', 'later', 'The handoff was not written: the docs folder is not writable — fix the folder permissions, then try again.'],
    ['no_docs_folder', 'never', 'The handoff was not written: this project has no docs folder yet — set one.'],
    ['path_escapes_docs_folder', 'never', 'The handoff was not written: a link in the docs folder leads outside it — remove the link.'],
  ] as const)('fails with a readable sentence when the daemon answers %s', async (code, retry, sentence) => {
    const fleetApi = { getHandoffPreview: vi.fn(), saveHandoff: vi.fn().mockRejectedValue(envelopeError(code, 409, retry)) };

    const failure = await createHandoffPreviewApi(fleetApi).save('s1', SECTIONS).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HandoffPreviewApiError);
    expect(failure).toMatchObject({ copy: sentence });
  });

  it('fails with the connection copy when the daemon cannot be reached while saving', async () => {
    const fleetApi = { getHandoffPreview: vi.fn(), saveHandoff: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) };

    const failure = await createHandoffPreviewApi(fleetApi).save('s1', SECTIONS).catch((error: unknown) => error);

    expect(failure).toMatchObject({ copy: 'The handoff was not written — check your connection, then try again.' });
  });
});
