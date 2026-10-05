import { signal } from '@angular/core';
import type { ReopenMode } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';

/** Reopens a closed manager, fresh from its mission or back into its previous conversation, and keeps the refusal to show. */
export class ManagerReopenAction {
  readonly pending = signal(false);
  readonly errorText = signal<string | null>(null);

  constructor(private readonly api: FleetApiService) {}

  reset(): void {
    this.pending.set(false);
    this.errorText.set(null);
  }

  async run(input: { sessionId: string; mode: ReopenMode }): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    this.errorText.set(null);
    try {
      await this.api.reopenSession(input.sessionId, input.mode);
    } catch (error) {
      this.errorText.set(copyFor(error, { action: 'reopen_manager' }).text);
    } finally {
      this.pending.set(false);
    }
  }
}
