import { signal } from '@angular/core';
import type { ManagerView } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import type { PulseMessage } from './pulse-now';

export const PULSES_PAUSED_HEADER = 'Pulses paused';
export const PAUSED_COUNTDOWN_PLACEHOLDER = '—';
export const PAUSED_WAKE_LINE = 'timer · child message · trigger — one pulse is sent on resume';

export function pauseButtonGlyph(isPaused: boolean): string {
  return isPaused ? '▶' : '❚❚';
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
      this.message.set({ text: copyFor(error, { action: 'pause_manager' }).text, kind: 'error' });
    } finally {
      this.pending.set(false);
    }
  }
}
