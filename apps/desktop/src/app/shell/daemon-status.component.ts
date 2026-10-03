import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { environment } from '../../environments/environment';

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
  /** The daemon version when it differs from the app version; null otherwise. */
  readonly mismatchedDaemonVersion = input<string | null>(null);

  private readonly isMismatched = computed(() => this.connected() && this.mismatchedDaemonVersion() !== null);
  protected readonly state = computed(() => {
    if (this.isMismatched()) return 'mismatch';
    return this.connected() ? 'connected' : 'reconnecting';
  });
  protected readonly label = computed(() => {
    if (this.isMismatched()) return `Daemon ${this.mismatchedDaemonVersion()}`;
    return this.connected() ? 'Connected' : 'Reconnecting';
  });
  protected readonly dotColorVar = computed(() => (this.connected() && !this.isMismatched() ? 'var(--state-idle)' : 'var(--state-waiting-permission)'));
  protected readonly tooltip = computed(() => {
    if (this.isMismatched()) return 'Daemon and app versions differ — restart the daemon';
    return this.connected()
      ? `Connected to the daemon on ${environment.daemonAddress}`
      : `Reconnecting to the daemon on ${environment.daemonAddress}`;
  });
}
