import { render, screen } from '@testing-library/angular/zoneless';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { SettingsComponent } from './settings.component';

async function renderSettings(models: () => Promise<unknown> = () => Promise.resolve({ haiku: 'claude-haiku-4-5' })) {
  return render(SettingsComponent, { providers: [{ provide: FleetApiService, useValue: { models: vi.fn(models) } }] });
}

describe('SettingsComponent layout', () => {
  it('fills the outlet by making its host a flex item that grows and can shrink', async () => {
    const { fixture } = await renderSettings();

    const host = getComputedStyle(fixture.nativeElement as HTMLElement);

    expect(host.display).toBe('flex');
    expect(host.flexGrow).toBe('1');
    expect(host.flexShrink).toBe('1');
    expect(host.minWidth).toBe('0px');
  });

  it('paints the load error with the app error token', async () => {
    await renderSettings(() => Promise.reject(new Error('down')));

    const error = await screen.findByTestId('models-error');

    expect(getComputedStyle(error).color).toBe('var(--state-error)');
  });

  it('gives the value pills the fixed mockup height and centres their text', async () => {
    await renderSettings();
    const pill = (await screen.findByTestId('model-row-haiku')).querySelector('.value') as HTMLElement;

    const style = getComputedStyle(pill);

    expect(style.height).toBe('1.75rem');
    expect(style.display).toBe('inline-flex');
    expect(style.alignItems).toBe('center');
  });

  it('shows the app focus ring on a focused tab', async () => {
    const { fixture } = await renderSettings();
    const stylesheet = Array.from(document.querySelectorAll('style')).map((style) => style.textContent).join('\n');

    expect(fixture).toBeTruthy();
    expect(stylesheet).toMatch(/\.tab(\[[^\]]+\])?:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)[^}]*outline-offset:\s*-2px/);
  });
});
