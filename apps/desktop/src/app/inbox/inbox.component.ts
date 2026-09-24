import { Component, computed, inject } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

@Component({
  selector: 'of-inbox',
  imports: [JsonPipe],
  template: `
    <h2>Inbox <span class="badge">{{ events.approvals().length }}</span></h2>
    @for (item of items(); track item.id) {
      <article class="approval" [attr.data-testid]="'inbox-item'">
        <header>{{ item.sessionLabel }} wants to run <code>{{ item.toolName }}</code></header>
        <pre>{{ item.toolInput | json }}</pre>
        <button data-testid="inbox-allow" (click)="decide(item.id, 'allow')">Allow</button>
        <button data-testid="inbox-deny" (click)="decide(item.id, 'deny')">Deny</button>
      </article>
    } @empty {
      <p class="empty">Nothing waiting for you.</p>
    }
  `,
  styles: `
    .approval { border: 0.0625rem solid #ddd; border-radius: 0.375rem; padding: 0.6rem; margin: 0.5rem 0 }
    pre { max-height: 10rem; overflow: auto }
    .badge { background: #d97706; color: white; border-radius: 999px; padding: 0 0.5rem; font-size: 0.8rem }
  `,
})
export class InboxComponent {
  readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);

  readonly items = computed(() =>
    this.events.approvals().map((approval) => {
      const session = this.events.sessions().find((s) => s.id === approval.sessionId);
      const sessionLabel = session ? `${session.emoji} ${session.name}` : approval.sessionId;
      return { ...approval, sessionLabel };
    }),
  );

  decide(id: string, behavior: 'allow' | 'deny'): void { void this.api.decide(id, behavior); }
}
