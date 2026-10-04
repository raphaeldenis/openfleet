import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsComponent } from './settings.component';

type SectionName = 'General' | 'Models' | 'Daemon' | 'Diagnostics' | 'About';

interface DisabledRow {
  section: SectionName;
  name: string;
  buttonTestId: string;
  value: string;
  reason: string;
}

const DISABLED_ROWS: DisabledRow[] = [
  { section: 'General', name: 'Docs folder root', buttonTestId: 'general-docs-root', value: '—', reason: 'Not configurable in this build yet' },
  { section: 'General', name: 'Write a handoff when a session closes', buttonTestId: 'general-handoff-on-close', value: 'Off', reason: 'Set handoff.writeOnClose in config.json' },
  { section: 'General', name: 'Agents reply and write in', buttonTestId: 'general-reply-language', value: '—', reason: 'Not available yet — no language setting in the daemon' },
  { section: 'Diagnostics', name: 'Last crash', buttonTestId: 'diagnostics-last-crash', value: '—', reason: 'Not available yet — crash logs are not collected' },
];

const ROW_NAMES_BY_SECTION: Record<'General' | 'Daemon' | 'Diagnostics', string[]> = {
  General: ['Setup', 'Theme', 'Docs folder root', 'Write a handoff when a session closes', 'Agents reply and write in', 'Projects'],
  Daemon: ['Address', 'Admin token', 'Log', 'Config file'],
  Diagnostics: ['Export diagnostics bundle…', 'Copy reference list', 'Last crash'],
};

async function renderSettingsOn(section: SectionName) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))));
  const view = await render(SettingsComponent);
  if (section !== 'General') await userEvent.click(screen.getByRole('tab', { name: section }));
  return view;
}

function rowNamesShown(): string[] {
  return Array.from(document.querySelectorAll('.rows .name')).map((name) => name.textContent?.trim() ?? '');
}

function reasonDescribing(control: HTMLElement): string | undefined {
  const reasonId = control.getAttribute('aria-describedby');
  return reasonId ? document.getElementById(reasonId)?.textContent?.trim() : undefined;
}

describe('Settings → rows without a backing setting', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  describe.each(DISABLED_ROWS)('$section › $name', ({ section, name, buttonTestId, value, reason }) => {
    it('is drawn as a disabled control showing its value', async () => {
      await renderSettingsOn(section);

      const control = screen.getByTestId(buttonTestId);

      expect(screen.getByText(name)).toBeInTheDocument();
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute('aria-disabled', 'true');
      expect(control).toHaveTextContent(value);
    });

    it('tells why, in a visible line under the description, in the tooltip and as the control description', async () => {
      await renderSettingsOn(section);

      const control = screen.getByTestId(buttonTestId);

      expect(screen.getByText(reason)).toBeVisible();
      expect(control).toHaveAttribute('title', reason);
      expect(reasonDescribing(control)).toBe(reason);
    });

    it('is drawn with a dashed border and a dimmed look', async () => {
      await renderSettingsOn(section);

      const look = getComputedStyle(screen.getByTestId(buttonTestId));

      expect(look.borderTopStyle).toBe('dashed');
      expect(look.opacity).toBe('0.6');
      expect(look.cursor).toBe('not-allowed');
    });

    it('cannot be activated by click or keyboard, and cannot take focus', async () => {
      await renderSettingsOn(section);
      const control = screen.getByTestId(buttonTestId);
      const onActivate = vi.fn();
      control.addEventListener('click', onActivate);

      await userEvent.click(control);
      control.focus();
      await userEvent.keyboard('{Enter}');
      await userEvent.keyboard(' ');

      expect(onActivate).not.toHaveBeenCalled();
      expect(control).not.toHaveFocus();
    });
  });

  it.each(Object.entries(ROW_NAMES_BY_SECTION))('lists exactly the %s rows, in order', async (section, expectedNames) => {
    await renderSettingsOn(section as SectionName);

    expect(rowNamesShown()).toEqual(expectedNames);
  });

  it('keeps the settings that do exist enabled next to the disabled ones', async () => {
    await renderSettingsOn('General');

    expect(screen.getByRole('button', { name: 'Run setup again →' })).toBeEnabled();
    expect(screen.getByTestId('general-theme')).toBeEnabled();
  });

  describe('Daemon › Config file', () => {
    it('is read-only text with the config path and the hand-edit hint, not a button', async () => {
      await renderSettingsOn('Daemon');

      const path = screen.getByTestId('daemon-config-path');

      expect(path).toHaveTextContent('~/.openfleet/config.json');
      expect(path.tagName).toBe('SPAN');
      expect(screen.getByText('Edited by hand for now · restart the daemon after changes')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /config/i })).not.toBeInTheDocument();
    });
  });

  describe('log path', () => {
    it('shows the real daemon log path on Daemon › Log', async () => {
      await renderSettingsOn('Daemon');

      expect(screen.getByTestId('daemon-log-path')).toHaveTextContent('~/.openfleet/logs/daemon.log');
    });

    it('names the real daemon log path in the About › Logs description', async () => {
      await renderSettingsOn('About');

      expect(screen.getByText(/~\/\.openfleet\/logs\/daemon\.log and the app log/)).toBeInTheDocument();
    });
  });
});
