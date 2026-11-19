import type { TriggerRun } from '@openfleet/shared';
import { screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TriggerView } from '../core/playbook-trigger-views';
import { ApiError } from '../core/fleet-api.service';
import { copyFor } from '../core/error-copy';
import { FIRST, choose, deferred, letPendingAnswersLand, openEditor, renderTriggers, save, trigger, type FakeApi } from './triggers-spec-support';

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

  describe('a RUN this screen cannot rebuild', () => {
    const unknownKind = { kind: 'shell', command: 'ls' } as unknown as TriggerRun;
    const unknownField = { kind: 'notify', title: 'T', message: 'M', channel: 'slack' } as unknown as TriggerRun;
    const playbookWithInputs = { kind: 'run_playbook', playbookId: 'pb1', inputs: { depth: 2 } } as TriggerRun;

    it.each<[string, TriggerRun]>([['an unknown kind', unknownKind], ['an unknown field', unknownField], ['the inputs of a playbook', playbookWithInputs]])(
      'leaves a RUN with %s as stored: it says so and sends no RUN', async (_case, run) => {
        const { api } = await openWith({ run });
        expect(screen.getByTestId('run-not-editable')).toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: 'Action' })).toBeNull();

        await userEvent.type(textbox('Titre'), '!');
        await save();

        expect(lastUpdate(api).changes).not.toHaveProperty('run');
      },
    );
  });

  describe('the daemon stays the authority', () => {
    it('shows the refusal of the daemon and keeps the RUN typed in the form', async () => {
      const updateTrigger = vi.fn(() => Promise.reject(new ApiError(400, 'the run is refused', 'trigger_field_prefix')));
      await openWith({ api: { updateTrigger } });
      await replaceText('Message', 'Tapé');

      await save();

      expect(await screen.findByTestId('write-error')).toHaveTextContent(copyFor(new ApiError(400, 'the run is refused', 'trigger_field_prefix'), { action: 'generic' }).text);
      expect(textbox('Message')).toHaveValue('Tapé');
    });
  });

  describe('the review before arming', () => {
    it('shows the RUN just saved as plain text, control characters written as their code', async () => {
      let isSaved = false;
      const savedRun: TriggerRun = { kind: 'notify', title: 'Alerte', message: 'a\u001bb <b>gras</b>' };
      const listTriggers = vi.fn(() => Promise.resolve([isSaved ? trigger({ contentRev: 3, run: savedRun }) : trigger()]));
      const updateTrigger = vi.fn(() => { isSaved = true; return Promise.resolve(trigger({ contentRev: 3, run: savedRun })); });
      await openWith({ api: { listTriggers, updateTrigger } });
      await replaceText('Titre de la notification', 'Alerte');
      await replaceText('Message', 'a\u001bb <b>gras</b>');

      await save();

      const review = await screen.findByTestId('review-fields');
      expect(review).toHaveTextContent('Alors · message');
      expect(review).toHaveTextContent('a\\u001bb <b>gras</b>');
      expect(review.querySelector('b')).toBeNull();
      expect(screen.getByTestId('edit-saved-notice')).toBeInTheDocument();
    });
  });

  describe('focus and announcements', () => {
    it('puts the focus on the first field of the action the human switches to', async () => {
      const { fixture } = await openWith();

      await chooseOption('Action', 'Fermeture d’une session');
      await fixture.whenStable();

      expect(textbox('Identifiant de la session')).toHaveFocus();
    });
  });

  describe('the playbook of a run_playbook RUN', () => {
    const playbook = (id: string, name: string, projectId = 'p1') => ({ id, name, projectId, contentRev: 1, flow: { cells: [] } });
    const PLAYBOOK_ACTION = 'Lancer un playbook';
    const listOf = (...items: ReturnType<typeof playbook>[]) => vi.fn(() => Promise.resolve(items));
    /** The Playbooks tab reads the same list when the screen opens; the answers queued here start with the first read made by the editor. */
    function listAnsweringFromEditor(...answers: Promise<ReturnType<typeof playbook>[]>[]) {
      let isEditorOpen = false;
      const queue = [...answers];
      const listPlaybooks = vi.fn(() => (isEditorOpen && queue.length > 0 ? queue.shift()! : Promise.resolve([] as ReturnType<typeof playbook>[])));
      return { listPlaybooks, editorOpened: () => { isEditorOpen = true; } };
    }

    it('offers only the playbooks of the project of the trigger and sends the one chosen', async () => {
      const listPlaybooks = listOf(playbook('pb1', 'Nettoyage'), playbook('pb2', 'Autre projet', 'p2'), playbook('pb3', 'Rapport'));
      const { api } = await openWith({ api: { listPlaybooks } });

      await chooseOption('Action', PLAYBOOK_ACTION);
      const chooser = await screen.findByRole('combobox', { name: 'Playbook' });
      await chooseOption('Playbook', 'Rapport');
      await save();

      expect(Array.from(chooser.querySelectorAll('option')).map((option) => option.textContent)).toEqual(['Choisir un playbook', 'Nettoyage', 'Rapport']);
      expect(lastUpdate(api).changes.run).toEqual({ kind: 'run_playbook', playbookId: 'pb3' });
    });

    it('asks the daemon for the playbooks of the project of the trigger', async () => {
      const listPlaybooks = listOf(playbook('pb1', 'Nettoyage'));
      await openWith({ api: { listPlaybooks } });

      await chooseOption('Action', PLAYBOOK_ACTION);
      await screen.findByRole('combobox', { name: 'Playbook' });

      expect(listPlaybooks).toHaveBeenCalledWith('p1');
    });

    it('never lets the human type a playbook identifier', async () => {
      await openWith({ api: { listPlaybooks: listOf(playbook('pb1', 'Nettoyage')) } });

      await chooseOption('Action', PLAYBOOK_ACTION);
      await screen.findByRole('combobox', { name: 'Playbook' });

      expect(screen.queryByRole('textbox', { name: /playbook/i })).toBeNull();
    });

    it('keeps the save disabled until a playbook is chosen', async () => {
      await openWith({ api: { listPlaybooks: listOf(playbook('pb1', 'Nettoyage')) } });

      await chooseOption('Action', PLAYBOOK_ACTION);
      await screen.findByRole('combobox', { name: 'Playbook' });

      expect(saveButton()).toBeDisabled();
      expect(screen.getByTestId('editor-problem')).toHaveTextContent(/^Alors · playbookId : /);
    });

    it('announces the loading, then the failure with a way to try again', async () => {
      const answer = deferred<ReturnType<typeof playbook>[]>();
      const { listPlaybooks, editorOpened } = listAnsweringFromEditor(answer.promise, Promise.resolve([playbook('pb1', 'Nettoyage')]));
      const { fixture } = await openWith({ api: { listPlaybooks } });
      editorOpened();

      await chooseOption('Action', PLAYBOOK_ACTION);
      expect(await screen.findByRole('status', { name: 'Chargement des playbooks' })).toBeInTheDocument();
      answer.reject(new ApiError(500, 'boom', 'internal'));
      await letPendingAnswersLand(fixture);
      expect(screen.getByTestId('playbooks-unavailable')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Réessayer les playbooks' }));

      expect(await screen.findByRole('combobox', { name: 'Playbook' })).toBeInTheDocument();
    });

    it('writes the name of a playbook as plain text, control characters as their code', async () => {
      await openWith({ api: { listPlaybooks: listOf(playbook('pb1', 'Net\u202Etoyage')) } });

      await chooseOption('Action', PLAYBOOK_ACTION);

      expect(await screen.findByRole('option', { name: 'Net\\u202etoyage' })).toBeInTheDocument();
    });

    it('names the playbook the form was opened with when the project does not list it, and keeps it chosen', async () => {
      const stored: TriggerRun = { kind: 'run_playbook', playbookId: 'pb-gone' };
      const { api } = await openWith({ run: stored, api: { listPlaybooks: listOf(playbook('pb1', 'Nettoyage')) } });

      const chooser = await screen.findByRole('combobox', { name: 'Playbook' });
      expect(chooser).toHaveValue('pb-gone');
      expect(screen.getByRole('option', { name: 'pb-gone — introuvable parmi les playbooks du projet' })).toBeInTheDocument();
      await userEvent.type(textbox('Titre'), '!');
      await save();

      expect(lastUpdate(api).changes).not.toHaveProperty('run');
    });

    it('ignores the playbooks that answer late for a trigger the human left', async () => {
      const lateAnswer = deferred<ReturnType<typeof playbook>[]>();
      const second = trigger({ id: 't2', title: 'Surveiller la table' });
      const { listPlaybooks, editorOpened } = listAnsweringFromEditor(lateAnswer.promise, Promise.resolve([playbook('pb2', 'Du second')]));
      const { fixture } = await openWith({ api: { listPlaybooks }, triggers: [trigger(), second] });
      editorOpened();
      await chooseOption('Action', PLAYBOOK_ACTION);
      await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
      await choose('Surveiller la table');
      await openEditor();
      await chooseOption('Action', PLAYBOOK_ACTION);
      await screen.findByRole('option', { name: 'Du second' });

      lateAnswer.resolve([playbook('pb1', 'Du premier')]);
      await letPendingAnswersLand(fixture);

      expect(screen.queryByRole('option', { name: 'Du premier' })).toBeNull();
      expect(screen.getByRole('option', { name: 'Du second' })).toBeInTheDocument();
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
