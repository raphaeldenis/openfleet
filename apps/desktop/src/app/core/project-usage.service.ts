import { Injectable, inject, signal, type Signal, type WritableSignal } from '@angular/core';
import { FleetApiService } from './fleet-api.service';
import type { TokenUsageLoad } from './session-usage.service';

/** Holds the token usage of each project for the current UTC day; an entry changes only when `refresh` is called. */
@Injectable({ providedIn: 'root' })
export class ProjectUsageService {
  private readonly api = inject(FleetApiService);
  private readonly loads = new Map<string, WritableSignal<TokenUsageLoad>>();
  private readonly projectsBeingRefreshed = new Set<string>();
  private readonly projectsToRefreshAgain = new Set<string>();

  todayOf(projectId: string): Signal<TokenUsageLoad> {
    return this.signalOf(projectId).asReadonly();
  }

  /** A refresh requested while another one is in flight makes the project read once more when that one ends. */
  async refresh(projectId: string): Promise<void> {
    const isAlreadyBeingRefreshed = this.projectsBeingRefreshed.has(projectId);
    if (isAlreadyBeingRefreshed) {
      this.projectsToRefreshAgain.add(projectId);
      return;
    }
    this.projectsBeingRefreshed.add(projectId);
    try {
      do {
        this.projectsToRefreshAgain.delete(projectId);
        await this.readOnce(projectId);
      } while (this.projectsToRefreshAgain.has(projectId));
    } finally {
      this.projectsBeingRefreshed.delete(projectId);
    }
  }

  private async readOnce(projectId: string): Promise<void> {
    const load = this.signalOf(projectId);
    try {
      load.set(await this.api.getProjectUsageToday(projectId));
    } catch {
      load.set('unavailable');
    }
  }

  private signalOf(projectId: string): WritableSignal<TokenUsageLoad> {
    const existing = this.loads.get(projectId);
    if (existing) return existing;
    const created = signal<TokenUsageLoad>(undefined);
    this.loads.set(projectId, created);
    return created;
  }
}
