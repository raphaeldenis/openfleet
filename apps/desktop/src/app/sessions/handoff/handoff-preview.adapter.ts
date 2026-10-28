import type { HandoffContent, HandoffPreview } from '@openfleet/shared';
import { copyFor, type ErrorAction } from '../../core/error-copy';
import type { FleetApiService } from '../../core/fleet-api.service';
import { HandoffPreviewApiError, type HandoffPreviewApi, type HandoffSaveResult } from './handoff-preview.api';

async function failingWithCopyOf<Result>(action: ErrorAction, call: () => Promise<Result>): Promise<Result> {
  try {
    return await call();
  } catch (error) {
    throw new HandoffPreviewApiError(copyFor(error, { action }).text);
  }
}

/** Connects the preview store to the daemon: the preview is read from, and the handoff written through, the real routes. */
export function createHandoffPreviewApi(fleetApi: Pick<FleetApiService, 'getHandoffPreview' | 'saveHandoff'>): HandoffPreviewApi {
  return {
    getPreview(sessionId: string): Promise<HandoffPreview> {
      return failingWithCopyOf('load_handoff', () => fleetApi.getHandoffPreview(sessionId));
    },
    save(sessionId: string, sections: HandoffContent): Promise<HandoffSaveResult> {
      return failingWithCopyOf('save_handoff', () => fleetApi.saveHandoff(sessionId, sections));
    },
  };
}
