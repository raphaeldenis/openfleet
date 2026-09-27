import { ApplicationRef, Component, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { afterEach, describe, expect, it } from 'vitest';
import { appConfig } from './app.config';

@Component({
  selector: 'test-async-signal-host',
  template: `<span data-testid="value">{{ value() }}</span>`,
})
class AsyncSignalHostComponent {
  readonly value = signal('stale');
}

describe('appConfig', () => {
  let appRef: ApplicationRef | undefined;
  let host: HTMLElement | undefined;

  afterEach(() => {
    appRef?.destroy();
    host?.remove();
    appRef = undefined;
    host = undefined;
  });

  it('renders a signal write that happens outside a DOM event handler (e.g. a WebSocket push resuming after an await), with no manual detectChanges call', async () => {
    // Arrange — a real bootstrap through the production config, not TestBed (TestBed always forces
    // its own zoneless scheduler regardless of what appConfig provides, so it can't catch this).
    host = document.createElement('test-async-signal-host');
    document.body.appendChild(host);
    appRef = await bootstrapApplication(AsyncSignalHostComponent, appConfig);
    const instance = appRef.components[0].instance as AsyncSignalHostComponent;

    // Act — the write happens on a plain timer tick, mimicking a WebSocket message handler:
    // no Angular-wrapped click listener runs afterwards to force a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    instance.value.set('fresh');
    await appRef.whenStable();

    // Assert
    expect(host.querySelector('[data-testid="value"]')?.textContent).toBe('fresh');
  });
});
