import { Component, effect, ElementRef, inject, input, OnDestroy, untracked, viewChild } from '@angular/core';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { Subscription } from 'rxjs';
import { FleetEventsService } from '../core/fleet-events.service';

@Component({
  selector: 'of-terminal',
  // flex: 1 1 auto + min-height: 0 lets this shrink below its content size — without min-height: 0 a
  // flex item's automatic minimum is its content size, so a sibling added next to it (the permission
  // gate card) gets pushed out of view instead of sharing the row.
  host: { style: 'display: block; position: relative; flex: 1 1 auto; min-height: 0; height: 100%;' },
  template: `
    <div #host class="host" data-testid="terminal"></div>
    @if (!connected()) {
      <div class="readonly-note" data-testid="terminal-readonly" role="status">Read-only — reconnecting…</div>
    }
  `,
  styles: `
    .host { height: 100% }
    .readonly-note {
      position: absolute; top: .5rem; right: .5rem; padding: .25rem .625rem; border-radius: .375rem;
      border: 1px solid color-mix(in oklch, var(--state-waiting-permission) 45%, transparent);
      background: color-mix(in oklch, var(--state-waiting-permission) 20%, var(--panel));
      color: var(--state-waiting-permission); font-size: .6875rem; font-weight: 600;
    }
  `,
})
export class TerminalComponent implements OnDestroy {
  readonly sessionId = input.required<string>();
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly events = inject(FleetEventsService);
  protected readonly connected = this.events.connected;
  terminal?: Terminal;
  private outputSub?: Subscription;
  private readonly fit = new FitAddon();
  private readonly resizeObserver = new ResizeObserver(() => this.refit());

  constructor() {
    effect((onCleanup) => {
      const sessionId = this.sessionId();
      this.attach(sessionId);
      onCleanup(() => this.detach());
    });

    // A reconnect means the connection (and whatever we last saw) may be stale — clear and re-request
    // a fresh replay for whatever session is current right now, without re-running on every session switch.
    effect(() => {
      const reconnectCount = this.events.reconnectCount();
      if (reconnectCount === 0) return;
      untracked(() => {
        this.terminal?.clear();
        this.events.sendAttach(this.sessionId());
      });
    });

    // Blocks typing (xterm's own disableStdin) the instant the connection drops, so no keystroke typed
    // offline can ever be sent — it unblocks as soon as the socket is open again.
    effect(() => {
      const isConnected = this.events.connected();
      if (this.terminal) this.terminal.options.disableStdin = !isConnected;
    });
  }

  private attach(sessionId: string): void {
    const isConnected = untracked(() => this.events.connected());
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'Menlo, monospace', fontSize: 13, scrollback: 5000, disableStdin: !isConnected });
    terminal.loadAddon(this.fit);
    terminal.open(this.host().nativeElement);
    terminal.onData((data) => this.events.sendInput(sessionId, data));
    this.terminal = terminal;
    this.resizeObserver.observe(this.host().nativeElement);
    this.refit();

    // Subscribe before requesting attach: the daemon answers on the same ordered channel as live
    // output (replay first, then live), so subscribing first guarantees nothing is missed — no async
    // gap where a session switch could interleave and leave two subscriptions or write to a disposed
    // terminal (the bug this replaced: a REST fetch for replay, raced against the effect re-running).
    this.outputSub = this.events.output(sessionId).subscribe((data) => {
      if (this.sessionId() !== sessionId) return;
      terminal.write(data);
    });
    this.events.sendAttach(sessionId);
  }

  private refit(): void {
    if (!this.terminal) return;
    this.fit.fit();
    this.events.sendResize(this.sessionId(), this.terminal.cols, this.terminal.rows);
  }

  private detach(): void {
    this.resizeObserver.disconnect();
    this.outputSub?.unsubscribe();
    this.terminal?.dispose();
    this.terminal = undefined;
  }

  ngOnDestroy(): void { this.detach(); }
}
