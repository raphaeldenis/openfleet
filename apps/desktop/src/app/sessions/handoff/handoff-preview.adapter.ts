import type { HandoffContent, HandoffPreview } from '@openfleet/shared';
import { copyFor } from '../../core/error-copy';
import type { FleetApiService } from '../../core/fleet-api.service';
import { HandoffPreviewApiError, type HandoffPreviewApi, type HandoffSaveResult } from './handoff-preview.api';

export const SAVE_NOT_AVAILABLE_COPY = 'Saving handoffs is not available yet.';

/** Connects the preview store to the daemon: the preview is read from the real route, saving is not offered yet. */
export function createHandoffPreviewApi(fleetApi: Pick<FleetApiService, 'getHandoffPreview'>): HandoffPreviewApi {
  return {
    async getPreview(sessionId: string): Promise<HandoffPreview> {
      try {
        return await fleetApi.getHandoffPreview(sessionId);
      } catch (error) {
        throw new HandoffPreviewApiError(copyFor(error, { action: 'load_handoff' }).text);
      }
    },
    save(_sessionId: string, _sections: HandoffContent): Promise<HandoffSaveResult> {
      return Promise.reject(new HandoffPreviewApiError(SAVE_NOT_AVAILABLE_COPY));
    },
  };
}
