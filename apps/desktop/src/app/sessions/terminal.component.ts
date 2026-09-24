import { Component, effect, ElementRef, inject, input, OnDestroy, viewChild } from '@angular/core';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { Subscription } from 'rxjs';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

@Component({
  selector: 'of-terminal',
  template: `<div #host class="host" data-testid="terminal"></div>`,
  styles: `:host { display: block; height: 100% } .host { height: 100% }`,
})
export class TerminalComponent implements OnDestroy {
  readonly sessionId = input.required<string>();
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
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
  }

  private attach(sessionId: string): void {
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'Menlo, monospace', fontSize: 13, scrollback: 5000 });
    terminal.loadAddon(this.fit);
    terminal.open(this.host().nativeElement);
    terminal.onData((data) => this.events.sendInput(sessionId, data));
    this.terminal = terminal;
    this.resizeObserver.observe(this.host().nativeElement);
    this.refit();
    void this.replayRecentOutput(sessionId, terminal);
  }

  private async replayRecentOutput(sessionId: string, terminal: Terminal): Promise<void> {
    const { output } = await this.api.recentOutput(sessionId);
    if (output) terminal.write(output);
    this.outputSub = this.events.output(sessionId).subscribe((data) => terminal.write(data));
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
