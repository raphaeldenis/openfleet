import { Injectable, inject } from '@angular/core';
import { ActivityPageSchema, type ActivityPage } from '@openfleet/shared';
import { ApiError, FleetApiService } from './fleet-api.service';

export interface ToolkitActivityRequest {
  outcome?: 'error' | 'denied';
  tool?: string;
  cursor?: string;
}

/** Reads the activity log for the Toolkit screen: the calls agents made, which are the MCP tool calls. */
@Injectable({ providedIn: 'root' })
export class ToolkitActivityClient {
  private readonly api = inject(FleetApiService);

  async readPage({ outcome, tool, cursor }: ToolkitActivityRequest): Promise<ActivityPage> {
    const query = new URLSearchParams({ actor: 'agent' });
    if (outcome) query.set('outcome', outcome);
    if (tool) query.set('action', tool);
    if (cursor) query.set('cursor', cursor);
    const path = `/api/activity?${query.toString()}`;
    const parsed = ActivityPageSchema.safeParse(await this.api.call<unknown>(path));
    if (!parsed.success) throw new ApiError(200, `GET ${path} → unreadable activity`);
    return parsed.data;
  }
}
