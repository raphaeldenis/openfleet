import { Component, computed, inject, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

const GENERIC_DECISION_ERROR = 'Could not send decision — try again.';

@Component({
  selector: 'of-inbox',
  imports: [JsonPipe],
  template: `
    <h2>Inbox <span class="badge">{{ events.approvals().length }}</span></h2>
    @for (item of items(); track item.id) {
      <article class="approval" [attr.data-testid]="'inbox-item'">
        <header>{{ item.sessionLabel }} wants to run <code>{{ item.toolName }}</code></header>
        <pre>{{ item.toolInput | json }}</pre>
        <button data-testid="inbox-allow" [disabled]="item.pending" (click)="decide(item.id, 'allow')">Allow</button>
        <button data-testid="inbox-deny" [disabled]="item.pending" (click)="decide(item.id, 'deny')">Deny</button>
        @if (item.error) {
          <p class="error" data-testid="inbox-error">{{ item.error }}</p>
        }
      </article>
    } @empty {
      <p class="empty">Nothing waiting for you.</p>
    }
  `,
  styles: `
    .approval { border: 0.0625rem solid #ddd; border-radius: 0.375rem; padding: 0.6rem; margin: 0.5rem 0 }
    pre { max-height: 10rem; overflow: auto }
    .badge { background: #d97706; color: white; border-radius: 999px; padding: 0 0.5rem; font-size: 0.8rem }
    .error { color: #dc2626; font-size: 0.85rem; margin: 0.3rem 0 0 }
  `,
})
export class InboxComponent {
  readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  private readonly pendingIds = signal<ReadonlySet<string>>(new Set());
  private readonly dismissedIds = signal<ReadonlySet<string>>(new Set());
  private readonly errorsById = signal<Readonly<Record<string, string>>>({});

  readonly items = computed(() =>
    this.events.approvals()
      .filter((approval) => !this.dismissedIds().has(approval.id))
      .map((approval) => {
        const session = this.events.sessions().find((s) => s.id === approval.sessionId);
        const sessionLabel = session ? `${session.emoji} ${session.name}` : approval.sessionId;
        return { ...approval, sessionLabel, pending: this.pendingIds().has(approval.id), error: this.errorsById()[approval.id] };
      }),
  );

  async decide(id: string, behavior: 'allow' | 'deny'): Promise<void> {
    if (this.pendingIds().has(id)) return;
    this.setPending(id, true);
    this.clearError(id);
    try {
      await this.api.decide(id, behavior);
    } catch (error) {
      const isAlreadyResolved = error instanceof ApiError && error.status === 409;
      if (isAlreadyResolved) return this.dismiss(id);
      this.setError(id, GENERIC_DECISION_ERROR);
    } finally {
      this.setPending(id, false);
    }
  }

  private setPending(id: string, isPending: boolean): void {
    this.pendingIds.update((ids) => {
      const next = new Set(ids);
      if (isPending) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private setError(id: string, message: string): void {
    this.errorsById.update((errors) => ({ ...errors, [id]: message }));
  }

  private clearError(id: string): void {
    this.errorsById.update((errors) => Object.fromEntries(Object.entries(errors).filter(([key]) => key !== id)));
  }

  private dismiss(id: string): void {
    this.dismissedIds.update((ids) => new Set(ids).add(id));
  }
}
