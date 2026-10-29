import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewSessionFormComponent } from './new-session-form.component';
import { FleetApiService } from '../core/fleet-api.service';

const THEMES = ['dark', 'light'] as const;
const PROJECT_WITH_DOCS = { id: 'p1', name: 'Fleet', docsFolderPath: '/docs' };

function fakeApi() {
  return {
    listProjects: vi.fn().mockResolvedValue({ items: [PROJECT_WITH_DOCS], total: 1, limit: 200, offset: 0 }),
    listHandoffs: vi.fn().mockResolvedValue({ items: [] }),
    createSession: vi.fn().mockResolvedValue({ id: 's-new' }),
    createManagerSession: vi.fn().mockResolvedValue({ id: 'm-new' }),
  };
}

async function renderForm(api = fakeApi(), queryParams: Record<string, string> = {}) {
  await render(NewSessionFormComponent, {
    providers: [
      provideRouter([]),
      { provide: FleetApiService, useValue: api },
      { provide: ActivatedRoute, useValue: { queryParamMap: new BehaviorSubject(convertToParamMap(queryParams)) } },
    ],
  });
  return api;
}

const harnessGroup = () => screen.getByRole('radiogroup', { name: 'Harness' });
const modelGroup = () => screen.getByRole('radiogroup', { name: 'Model rung' });
const comesBefore = (first: HTMLElement, second: HTMLElement) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

afterEach(() => document.documentElement.removeAttribute('data-theme'));

describe.each(THEMES)('new session form, %s theme', (theme) => {
  const renderInTheme = async (api = fakeApi(), queryParams: Record<string, string> = {}) => {
    document.documentElement.setAttribute('data-theme', theme);
    return renderForm(api, queryParams);
  };

  describe('harness', () => {
    it('is chosen among four named cards, Claude Code being selected', async () => {
      await renderInTheme();

      const cards = within(harnessGroup()).getAllByRole('radio');

      expect(within(harnessGroup()).getByRole('radio', { name: /Claude Code/ })).toBeChecked();
      expect(cards).toHaveLength(4);
      expect(screen.queryByRole('combobox', { name: /harness/i })).toBeNull();
    });

    it.each(['Codex', 'opencode', 'Generic PTY'])('shows %s as not available yet and cannot be picked', async (label) => {
      await renderInTheme();

      const card = within(harnessGroup()).getByRole('radio', { name: new RegExp(label) });

      expect(card).toBeDisabled();
      expect(card.closest('label')).toHaveAttribute('title', 'not available yet');
    });
  });

  describe('model rung', () => {
    it('lists haiku, sonnet, opus and fable as radios, sonnet being selected', async () => {
      await renderInTheme();

      const rungs = within(modelGroup()).getAllByRole('radio');

      expect(rungs.map((rung) => rung.getAttribute('value'))).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
      expect(within(modelGroup()).getByRole('radio', { name: 'sonnet' })).toBeChecked();
      expect(screen.queryByRole('combobox', { name: /model/i })).toBeNull();
    });

    it('creates the session with the rung the user clicked', async () => {
      const api = await renderInTheme();
      await userEvent.type(screen.getByRole('textbox', { name: 'Directory' }), '/tmp/wt');
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Gimli');

      await userEvent.click(within(modelGroup()).getByRole('radio', { name: 'opus' }));
      await userEvent.click(screen.getByRole('button', { name: 'Create session' }));

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus', harness: 'claude-cli' }));
    });
  });

  describe('handoff picker', () => {
    it('comes after the Identity name field and not above the Agent section', async () => {
      await renderInTheme();

      const handoff = await screen.findByRole('combobox', { name: 'Start from a handoff' });

      expect(comesBefore(screen.getByRole('textbox', { name: 'Name' }), handoff)).toBe(true);
      expect(comesBefore(handoff, harnessGroup())).toBe(false);
    });

    it('is absent when creating a manager', async () => {
      await renderInTheme(fakeApi(), { mode: 'manager' });

      expect(screen.queryByRole('combobox', { name: 'Start from a handoff' })).toBeNull();
    });
  });
});
