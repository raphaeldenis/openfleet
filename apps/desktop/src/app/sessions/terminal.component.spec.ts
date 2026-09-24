import { render, waitFor } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TerminalComponent } from './terminal.component';
import { FleetEventsService } from '../core/fleet-events.service';
import { FleetApiService } from '../core/fleet-api.service';

describe('TerminalComponent', () => {
  it('forwards typed keys to the session and writes incoming output', async () => {
    const output = new Subject<string>();
    const fake = { output: () => output, sendInput: vi.fn(), sendResize: vi.fn(), sessions: signal([]), approvals: signal([]) };
    const fakeApi = { recentOutput: vi.fn().mockResolvedValue({ output: '' }) };
    const { fixture } = await render(TerminalComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [
        { provide: FleetEventsService, useValue: fake },
        { provide: FleetApiService, useValue: fakeApi },
      ],
    });
    const component = fixture.componentInstance;
    component.terminal!.input('y');
    expect(fake.sendInput).toHaveBeenCalledWith('s1', 'y');
    output.next('hello');
    await fixture.whenStable();
    expect(component.terminal!.buffer.active.getLine(0)?.translateToString(true)).toContain('hello');
  });

  it('replays recent output fetched from the daemon before live output arrives', async () => {
    const output = new Subject<string>();
    const fake = { output: () => output, sendInput: vi.fn(), sendResize: vi.fn(), sessions: signal([]), approvals: signal([]) };
    const fakeApi = { recentOutput: vi.fn().mockResolvedValue({ output: 'earlier output' }) };
    const { fixture } = await render(TerminalComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [
        { provide: FleetEventsService, useValue: fake },
        { provide: FleetApiService, useValue: fakeApi },
      ],
    });
    const component = fixture.componentInstance;
    expect(fakeApi.recentOutput).toHaveBeenCalledWith('s1');
    await waitFor(() => {
      expect(component.terminal!.buffer.active.getLine(0)?.translateToString(true)).toContain('earlier output');
    });
  });
});
