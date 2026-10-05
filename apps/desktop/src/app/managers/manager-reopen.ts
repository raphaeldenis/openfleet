import { signal } from '@angular/core';
import type { ReopenMode } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';

/** Reopens a closed manager, fresh from its mission or back into its previous conversation, and keeps the refusal to show. */
export class ManagerReopenAction {
  readonly pending = signal(false);
  readonly errorText = signal<string | null>(null);

  private currentRequestToken = 0;

  constructor(private readonly api: FleetApiService) {}

  reset(): void {
    this.currentRequestToken++;
    this.pending.set(false);
    this.errorText.set(null);
  }

  async run(input: { sessionId: string; mode: ReopenMode }): Promise<void> {
    if (this.pending()) return;
    const requestToken = ++this.currentRequestToken;
    const isStillCurrent = () => requestToken === this.currentRequestToken;
    this.pending.set(true);
    this.errorText.set(null);
    try {
      await this.api.reopenSession(input.sessionId, input.mode);
    } catch (error) {
      if (isStillCurrent()) this.errorText.set(copyFor(error, { action: 'reopen_manager' }).text);
    } finally {
      if (isStillCurrent()) this.pending.set(false);
    }
  }
}
