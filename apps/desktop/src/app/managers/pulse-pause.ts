import { signal } from '@angular/core';
import type { ManagerView } from '@openfleet/shared';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import type { PulseMessage } from './pulse-now';

function describePauseError(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return 'Manager not found';
  return 'Could not reach the server — check your connection';
}

/** Pauses a running manager or resumes a paused one; the daemon's manager.updated event refreshes the view. */
export class PulsePauseAction {
  readonly pending = signal(false);
  readonly message = signal<PulseMessage | null>(null);

  constructor(private readonly api: FleetApiService) {}

  reset(): void {
    this.pending.set(false);
    this.message.set(null);
  }

  async toggle(manager: Pick<ManagerView, 'sessionId' | 'pulseEnabled'>): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    this.message.set(null);
    try {
      await this.api.updateManager(manager.sessionId, { pulseEnabled: !manager.pulseEnabled });
    } catch (error) {
      this.message.set({ text: describePauseError(error), kind: 'error' });
    } finally {
      this.pending.set(false);
    }
  }
}
