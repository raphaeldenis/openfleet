import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

const DAEMON_ADDRESS = '127.0.0.1:7331';

@Component({
  selector: 'of-daemon-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span data-testid="daemon-status" [attr.data-state]="state()" [title]="tooltip()" class="daemon-status">
      <span class="dot" [style.background]="dotColorVar()"></span>
      <span>{{ label() }}</span>
    </span>
  `,
  styles: `
    .daemon-status { display: inline-flex; align-items: center; gap: .375rem; white-space: nowrap; color: var(--mut); }
    .dot { width: .5rem; height: .5rem; border-radius: 50%; flex: none; }
  `,
})
export class DaemonStatusComponent {
  readonly connected = input.required<boolean>();

  protected readonly state = computed(() => (this.connected() ? 'connected' : 'reconnecting'));
  protected readonly label = computed(() => (this.connected() ? 'Connected' : 'Reconnecting'));
  protected readonly dotColorVar = computed(() => (this.connected() ? 'var(--state-idle)' : 'var(--state-waiting-permission)'));
  protected readonly tooltip = computed(() =>
    this.connected() ? `Connected to the daemon on ${DAEMON_ADDRESS}` : `Reconnecting to the daemon on ${DAEMON_ADDRESS}`,
  );
}
