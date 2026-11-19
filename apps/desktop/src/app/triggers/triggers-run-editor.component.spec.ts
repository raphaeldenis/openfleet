import type { TriggerRun } from '@openfleet/shared';
import { screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TriggerView } from '../core/playbook-trigger-views';
import { FIRST, choose, openEditor, renderTriggers, save, trigger, type FakeApi } from './triggers-spec-support';

const textbox = (name: string) => screen.getByRole('textbox', { name });
const combobox = (name: string) => screen.getByRole('combobox', { name });
const replaceText = async (name: string, text: string) => { await userEvent.clear(textbox(name)); if (text !== '') await userEvent.type(textbox(name), text); };
const chooseOption = (name: string, option: string) => userEvent.selectOptions(combobox(name), option);
const saveButton = () => screen.getByRole('button', { name: 'Enregistrer' });

type UpdateCall = { triggerId: string; expectedRev: number; changes: { run?: unknown; title?: string } };
const lastUpdate = (api: { updateTrigger: ReturnType<typeof vi.fn> }) => api.updateTrigger.mock.calls.at(-1)![0] as UpdateCall;

async function openWith({ run, api, triggers }: { run?: TriggerRun; api?: FakeApi; triggers?: TriggerView[] } = {}) {
  const rendered = await renderTriggers({ triggers: triggers ?? [trigger(run === undefined ? {} : { run })], ...(api && { api }) });
  await choose(FIRST);
  await openEditor();
  return rendered;
}

describe('Trigger editor: the RUN', () => {
  describe('a RUN of the five kinds', () => {
    it('opens on the RUN as stored', async () => {
      await openWith();

      expect(combobox('Action')).toHaveValue('notify');
      expect(textbox('Titre de la notification')).toHaveValue('Inactive');
      expect(textbox('Message')).toHaveValue('Une session dort.');
    });

    it('sends no RUN when the human left it as stored', async () => {
      const { api } = await openWith();
      await userEvent.type(textbox('Titre'), '!');

      await save();

      expect(lastUpdate(api).changes).not.toHaveProperty('run');
    });

    it('sends the RUN the human edited against the revision the form was opened from', async () => {
      const { api } = await openWith();

      await replaceText('Message', 'Réveillez-la.');
      await save();

      expect(lastUpdate(api)).toMatchObject({
        triggerId: 't1', expectedRev: 2, changes: { run: { kind: 'notify', title: 'Inactive', message: 'Réveillez-la.' } },
      });
    });

    it.each<[string, string, Record<string, string>, TriggerRun]>([
      ['prompt_manager', 'Prompt à un manager', { Prompt: 'Réveille-toi' }, { kind: 'prompt_manager', prompt: 'Réveille-toi' }],
      ['prompt_session', 'Prompt à une session', { 'Identifiant de la session': 's9', Prompt: 'Continue' }, { kind: 'prompt_session', sessionId: 's9', prompt: 'Continue' }],
      ['close_session', 'Fermeture d’une session', { 'Identifiant de la session': 's9' }, { kind: 'close_session', sessionId: 's9' }],
    ])('builds a %s RUN when the human switches the action to it', async (_kind, optionLabel, fields, expected) => {
      const { api } = await openWith();

      await chooseOption('Action', optionLabel);
      for (const [name, text] of Object.entries(fields)) await replaceText(name, text);
      await save();

      expect(lastUpdate(api).changes.run).toEqual(expected);
    });

    it('sends the manager of a prompt_manager RUN only when the human typed one', async () => {
      const { api } = await openWith({ run: { kind: 'prompt_manager', managerId: 'm7', prompt: 'Salut' } });
      expect(textbox('Identifiant du manager (facultatif)')).toHaveValue('m7');

      await replaceText('Identifiant du manager (facultatif)', '');
      await save();

      expect(lastUpdate(api).changes.run).toEqual({ kind: 'prompt_manager', prompt: 'Salut' });
    });
  });

  describe('the shared schema is the only judge', () => {
    it('refuses a blank message with the words of the schema and keeps the save disabled', async () => {
      await openWith();

      await replaceText('Message', '   ');

      expect(await screen.findByTestId('editor-problem')).toHaveTextContent(/^Alors · message : /);
      expect(saveButton()).toBeDisabled();
    });
  });
});
