import { signal } from '@angular/core';
import { ApiError, FleetApiService } from '../core/fleet-api.service';

export type PulseMessage = { text: string; kind: 'info' | 'error' };

function describePulseError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return 'This session is closed';
  if (error instanceof ApiError && error.status === 404) return 'Manager not found';
  return 'Could not reach the server — check your connection';
}

export class PulseNowAction {
  readonly pending = signal(false);
  readonly message = signal<PulseMessage | null>(null);

  constructor(private readonly api: FleetApiService) {}

  reset(): void {
    this.pending.set(false);
    this.message.set(null);
  }

  async run(sessionId: string): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    this.message.set(null);
    try {
      const result = await this.api.pulseNow(sessionId);
      if (result.coalesced) this.message.set({ text: 'Pulse coalesced — already queued', kind: 'info' });
    } catch (error) {
      this.message.set({ text: describePulseError(error), kind: 'error' });
    } finally {
      this.pending.set(false);
    }
  }
}
