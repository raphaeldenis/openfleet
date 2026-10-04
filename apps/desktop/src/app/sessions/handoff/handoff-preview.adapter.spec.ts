import type { HandoffPreview } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../core/fleet-api.service';
import { HandoffPreviewApiError } from './handoff-preview.api';
import { SAVE_NOT_AVAILABLE_COPY, createHandoffPreviewApi } from './handoff-preview.adapter';

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
  const kind = status === 404 ? 'not_found' : 'internal';
  return new ApiError(status, 'GET /x', code, { error: code, kind, retry, message: 'raw', ...(kind === 'internal' && { id: '3f9a1c2e' }) } as never);
}

describe('createHandoffPreviewApi', () => {
  it('reads the preview from the daemon route', async () => {
    const fleetApi = { getHandoffPreview: vi.fn().mockResolvedValue(PREVIEW) };

    const preview = await createHandoffPreviewApi(fleetApi).getPreview('s1');

    expect(preview).toBe(PREVIEW);
    expect(fleetApi.getHandoffPreview).toHaveBeenCalledWith('s1');
  });

  it('fails with the copy of the error table when the session is unknown', async () => {
    const fleetApi = { getHandoffPreview: vi.fn().mockRejectedValue(envelopeError('session_not_found', 404, 'never')) };

    const failure = await createHandoffPreviewApi(fleetApi).getPreview('s1').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HandoffPreviewApiError);
    expect(failure).toMatchObject({ copy: 'That session no longer exists.' });
  });

  it('fails with the connection copy when the daemon cannot be reached', async () => {
    const fleetApi = { getHandoffPreview: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) };

    const failure = await createHandoffPreviewApi(fleetApi).getPreview('s1').catch((error: unknown) => error);

    expect(failure).toMatchObject({ copy: 'The preview could not be loaded — check your connection, then try again.' });
  });

  it('refuses to save: saving handoffs is not available yet', async () => {
    const fleetApi = { getHandoffPreview: vi.fn() };

    const failure = await createHandoffPreviewApi(fleetApi).save('s1', SECTIONS).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HandoffPreviewApiError);
    expect(failure).toMatchObject({ copy: 'Saving handoffs is not available yet.' });
    expect(SAVE_NOT_AVAILABLE_COPY).toBe('Saving handoffs is not available yet.');
  });
});
