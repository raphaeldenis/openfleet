import type { TriggerCondition, TriggerWhen } from '@openfleet/shared';
import { screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../core/fleet-api.service';
import type { TriggerView } from '../core/playbook-trigger-views';
import { FIRST, choose, deferred, letPendingAnswersLand, openEditor, renderTriggers, save, trigger } from './triggers-spec-support';

const SECOND = 'Surveiller la table';

const condition = (id: string, overrides: Partial<TriggerCondition> = {}): TriggerCondition =>
  ({ id, join: 'and', lhs: 'event.session.state', op: 'eq', rhs: 'idle', caseInsensitive: false, ...overrides });
const idleCondition = condition('c1');

const textbox = (name: string) => screen.getByRole('textbox', { name });
const combobox = (name: string) => screen.getByRole('combobox', { name });
const replaceText = async (name: string, text: string) => { await userEvent.clear(textbox(name)); await userEvent.type(textbox(name), text); };
const chooseOption = (name: string, option: string) => userEvent.selectOptions(combobox(name), option);
const addCondition = () => userEvent.click(screen.getByRole('button', { name: 'Ajouter une condition' }));
const removeCondition = (position: number) => userEvent.click(screen.getByRole('button', { name: `Supprimer la condition ${position}` }));
const saveButton = () => screen.getByRole('button', { name: 'Enregistrer' });

type UpdateCall = { triggerId: string; expectedRev: number; changes: { conditions?: Record<string, unknown>[]; when?: unknown } };
const lastUpdate = (api: { updateTrigger: ReturnType<typeof vi.fn> }) => api.updateTrigger.mock.calls.at(-1)![0] as UpdateCall;

async function openWith({ conditions, when }: { conditions: TriggerCondition[]; when?: TriggerWhen }) {
  const rendered = await renderTriggers({ triggers: [trigger({ conditions, ...(when && { when }) })] });
  await choose(FIRST);
  await openEditor();
  return rendered;
}

describe('Trigger editor: the conditions', () => {
  it('opens on the conditions as stored, with the counter and the namespace of the event the source reads', async () => {
    await openWith({ conditions: [idleCondition] });

    expect(screen.getByTestId('conditions-counter')).toHaveTextContent('1/32');
    expect(screen.getByTestId('condition-namespace-1')).toHaveTextContent('event.session.');
    expect(textbox('Chemin de la condition 1')).toHaveValue('state');
    expect(combobox('Opérateur de la condition 1')).toHaveValue('eq');
    expect(textbox('Valeur de la condition 1')).toHaveValue('idle');
  });

  it('sends no conditions when the human left them as stored', async () => {
    const { api } = await openWith({ conditions: [idleCondition] });
    await userEvent.type(textbox('Titre'), '!');

    await save();

    expect(lastUpdate(api).changes).not.toHaveProperty('conditions');
  });

  it('sends the stored conditions first, with their ids, then the added one without an id, against the revision the form was opened from', async () => {
    const { api } = await openWith({ conditions: [idleCondition] });

    await addCondition();
    await replaceText('Chemin de la condition 2', 'error');
    await chooseOption('Jointure de la condition 2', 'or');
    await replaceText('Valeur de la condition 2', 'boom');
    await save();

    expect(lastUpdate(api)).toMatchObject({
      triggerId: 't1', expectedRev: 2,
      changes: {
        conditions: [
          { id: 'c1', join: 'and', lhs: 'event.session.state', op: 'eq', rhs: 'idle', caseInsensitive: false },
          { join: 'or', lhs: 'event.session.error', op: 'eq', rhs: 'boom', caseInsensitive: false },
        ],
      },
    });
    expect(lastUpdate(api).changes.conditions![1]).not.toHaveProperty('id');
  });

  it.each<[string, TriggerWhen, string]>([
    ['session_state', { source: 'session_state', state: 'idle', minutes: 10 }, 'event.session.'],
    ['silent_run', { source: 'silent_run', minutes: 10 }, 'event.session.'],
    ['cron', { source: 'cron', expression: '0 9 * * *', timezone: 'Europe/Paris', catchUp: 'skip' }, 'event.slot.'],
    ['integration_records', { source: 'integration_records', integrationId: 'i1', event: 'new_record' }, 'event.record.'],
    ['data_store_query', { source: 'data_store_query', storeId: 's1', event: 'new_matching_rows' }, 'event.row.'],
  ])('prefixes the path of a condition added to a %s trigger with the namespace of its event', async (_source, when, namespace) => {
    const { api } = await openWith({ conditions: [], when });

    await addCondition();
    await replaceText('Chemin de la condition 1', 'title');
    await save();

    expect(lastUpdate(api).changes.conditions![0]).toMatchObject({ lhs: `${namespace}title` });
  });

  it('offers both namespaces of a table event and sends the one chosen', async () => {
    const { api } = await openWith({ conditions: [], when: { source: 'data_store_query', storeId: 's1', event: 'row_updated' } });

    await addCondition();
    await chooseOption('Espace de la condition 1', 'event.previous.');
    await replaceText('Chemin de la condition 1', 'status');
    await save();

    expect(lastUpdate(api).changes.conditions![0]).toMatchObject({ lhs: 'event.previous.status' });
  });

  it('reads a stored condition of a table trigger under the namespace it was stored with', async () => {
    await openWith({
      conditions: [condition('c1', { lhs: 'event.previous.status' })],
      when: { source: 'data_store_query', storeId: 's1', event: 'row_updated' },
    });

    expect(combobox('Espace de la condition 1')).toHaveValue('event.previous.');
    expect(textbox('Chemin de la condition 1')).toHaveValue('status');
  });

  it('moves the conditions to the namespace of the source the human chooses, and sends them even though they were not edited', async () => {
    const { api } = await openWith({ conditions: [idleCondition] });

    await chooseOption('Source', 'cron');
    await replaceText('Expression cron', '0 9 * * *');
    await save();

    expect(screen.queryByTestId('conditions-counter')).toBeNull();
    expect(lastUpdate(api).changes.conditions).toEqual([
      { id: 'c1', join: 'and', lhs: 'event.slot.state', op: 'eq', rhs: 'idle', caseInsensitive: false },
    ]);
  });

  it('counts the conditions as they are added and removed', async () => {
    await openWith({ conditions: [idleCondition] });

    await addCondition();
    expect(screen.getByTestId('conditions-counter')).toHaveTextContent('2/32');
    await removeCondition(1);
    expect(screen.getByTestId('conditions-counter')).toHaveTextContent('1/32');
  });

  it('announces the counter to assistive technology', async () => {
    await openWith({ conditions: [idleCondition] });

    expect(within(screen.getByTestId('conditions-editor')).getByRole('status')).toHaveTextContent('1/32');
  });

  it('stops offering to add a condition at 32', async () => {
    const thirtyOne = Array.from({ length: 31 }, (_, index) => condition(`c${index}`));
    await openWith({ conditions: thirtyOne });
    expect(screen.getByRole('button', { name: 'Ajouter une condition' })).toBeEnabled();

    await addCondition();

    expect(screen.getByTestId('conditions-counter')).toHaveTextContent('32/32');
    expect(screen.getByRole('button', { name: 'Ajouter une condition' })).toBeDisabled();
    expect(screen.getByTestId('conditions-full')).toBeInTheDocument();
  });

  it('keeps the order of the conditions when one in the middle is removed', async () => {
    const { api } = await openWith({ conditions: [condition('c1'), condition('c2', { rhs: 'b' }), condition('c3', { rhs: 'c' })] });

    await removeCondition(2);
    await save();

    expect(lastUpdate(api).changes.conditions!.map((sent) => sent['id'])).toEqual(['c1', 'c3']);
  });

  it('joins the first condition with and, whatever it held, and offers no join for it', async () => {
    const { api } = await openWith({ conditions: [condition('c1'), condition('c2', { join: 'or', rhs: 'b' })] });
    expect(screen.queryByRole('combobox', { name: 'Jointure de la condition 1' })).toBeNull();

    await removeCondition(1);
    await save();

    expect(lastUpdate(api).changes.conditions).toEqual([expect.objectContaining({ id: 'c2', join: 'and' })]);
  });

  it('asks for no value and sends none for exists and not_exists', async () => {
    const { api } = await openWith({ conditions: [idleCondition] });

    await chooseOption('Opérateur de la condition 1', 'exists');
    expect(screen.queryByRole('textbox', { name: 'Valeur de la condition 1' })).toBeNull();
    await save();

    expect(lastUpdate(api).changes.conditions![0]).not.toHaveProperty('rhs');
  });

  it.each<[string, string, string, unknown]>([
    ['a number', 'number', '5', 5],
    ['a text', 'text', '5', '5'],
  ])('sends the value as %s when the human chose that type', async (_label, valueKind, typed, expected) => {
    const { api } = await openWith({ conditions: [idleCondition] });

    await chooseOption('Type de la valeur de la condition 1', valueKind);
    await replaceText('Valeur de la condition 1', typed);
    await save();

    expect(lastUpdate(api).changes.conditions![0]).toMatchObject({ rhs: expected });
  });

  it('sends a boolean value and keeps a stored boolean, a stored number and the case flag', async () => {
    const { api } = await openWith({ conditions: [condition('c1', { rhs: true }), condition('c2', { rhs: 2.5, op: 'gt' })] });
    expect(combobox('Valeur de la condition 1')).toHaveValue('true');
    expect(textbox('Valeur de la condition 2')).toHaveValue('2.5');

    await chooseOption('Valeur de la condition 1', 'false');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Ignorer la casse de la condition 2' }));
    await save();

    expect(lastUpdate(api).changes.conditions).toEqual([
      expect.objectContaining({ id: 'c1', rhs: false, caseInsensitive: false }),
      expect.objectContaining({ id: 'c2', rhs: 2.5, caseInsensitive: true }),
    ]);
  });

  it.each([
    ['a path left empty', 'Chemin de la condition 1', ''],
    ['a path with a space', 'Chemin de la condition 1', 'a b'],
    ['a path that starts with a dot', 'Chemin de la condition 1', '.state'],
    ['a value that is not a number', 'Valeur de la condition 1', 'abc'],
  ])('refuses %s without calling the daemon', async (_label, fieldName, value) => {
    const { api } = await openWith({ conditions: [idleCondition] });
    if (fieldName.startsWith('Valeur')) await chooseOption('Type de la valeur de la condition 1', 'number');

    await userEvent.clear(textbox(fieldName));
    if (value !== '') await userEvent.type(textbox(fieldName), value);

    expect(saveButton()).toBeDisabled();
    expect(screen.getByTestId('editor-problem')).toHaveTextContent('Condition 1');
    expect(api.updateTrigger).not.toHaveBeenCalled();
  });

  it('refuses a number left empty and a path longer than the schema allows', async () => {
    await openWith({ conditions: [idleCondition] });

    await chooseOption('Type de la valeur de la condition 1', 'number');
    await userEvent.clear(textbox('Valeur de la condition 1'));
    expect(saveButton()).toBeDisabled();

    await chooseOption('Type de la valeur de la condition 1', 'text');
    await replaceText('Chemin de la condition 1', 'a'.repeat(200));
    expect(saveButton()).toBeDisabled();
  });

  describe('a condition this screen cannot rebuild', () => {
    const unknownFieldCondition = { ...condition('c2', { rhs: 'b' }), future: 'z' } as unknown as TriggerCondition;
    const foreignPathCondition = condition('c2', { lhs: 'event.row.title' });

    it.each([
      ['a field it does not know', unknownFieldCondition],
      ['a path outside the namespace of the source', foreignPathCondition],
    ])('keeps a condition with %s in its place, untouched, and edits the others', async (_label, opaque) => {
      const { api } = await openWith({ conditions: [condition('c1'), opaque, condition('c3', { rhs: 'c' })] });
      expect(screen.getByTestId('condition-not-editable')).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Chemin de la condition 2' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Supprimer la condition 2' })).toBeNull();

      await replaceText('Chemin de la condition 3', 'other');
      await save();

      expect(lastUpdate(api).changes.conditions).toEqual([
        expect.objectContaining({ id: 'c1', lhs: 'event.session.state' }),
        opaque,
        expect.objectContaining({ id: 'c3', lhs: 'event.session.other' }),
      ]);
    });

    it('counts a condition it keeps untouched among the 32', async () => {
      await openWith({ conditions: [condition('c1'), unknownFieldCondition] });

      expect(screen.getByTestId('conditions-counter')).toHaveTextContent('2/32');
    });

    it('keeps every condition as stored and offers none to add when the WHEN is a source it does not know', async () => {
      const futureWhen = { source: 'webhook', url: 'x' } as unknown as TriggerWhen;
      const { api } = await openWith({ conditions: [idleCondition], when: futureWhen });

      expect(screen.getByTestId('condition-not-editable')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Ajouter une condition' })).toBeDisabled();
      await userEvent.type(textbox('Titre'), '!');
      await save();

      expect(lastUpdate(api).changes).not.toHaveProperty('conditions');
    });
  });

  describe('texts written in a condition are plain text', () => {
    it('writes the controls of an unreadable condition as their code and never as markup', async () => {
      const hostile = { ...condition('c1', { rhs: '<b>gras</b>‮' }), future: 'z' } as unknown as TriggerCondition;
      await openWith({ conditions: [hostile] });

      const shown = screen.getByTestId('condition-not-editable');

      expect(shown.querySelector('b')).toBeNull();
      expect(shown).toHaveTextContent('"rhs":"<b>gras</b>\\\\u202e"');
    });

    it('holds a value that looks like markup in the field, as text', async () => {
      await openWith({ conditions: [condition('c1', { rhs: '<img src=x onerror=boom>' })] });

      expect(textbox('Valeur de la condition 1')).toHaveValue('<img src=x onerror=boom>');
      expect(document.querySelector('img')).toBeNull();
    });
  });

  describe('the focus', () => {
    it('goes to the path of the condition just added', async () => {
      const { fixture } = await openWith({ conditions: [idleCondition] });

      await addCondition();
      await fixture.whenStable();

      expect(textbox('Chemin de la condition 2')).toHaveFocus();
    });

    it('goes to the condition that takes the place of the one removed', async () => {
      const { fixture } = await openWith({ conditions: [condition('c1'), condition('c2'), condition('c3')] });

      await removeCondition(2);
      await fixture.whenStable();

      expect(textbox('Chemin de la condition 2')).toHaveFocus();
    });

    it('goes to the previous condition when the last one is removed', async () => {
      const { fixture } = await openWith({ conditions: [condition('c1'), condition('c2')] });

      await removeCondition(2);
      await fixture.whenStable();

      expect(textbox('Chemin de la condition 1')).toHaveFocus();
    });

    it('goes to the add button when the last condition left is removed', async () => {
      const { fixture } = await openWith({ conditions: [idleCondition] });

      await removeCondition(1);
      await fixture.whenStable();

      expect(screen.getByRole('button', { name: 'Ajouter une condition' })).toHaveFocus();
    });

    it('can leave the conditions with the keyboard: the add button is a tab stop after the last condition', async () => {
      await openWith({ conditions: [idleCondition] });
      textbox('Chemin de la condition 1').focus();

      const addButton = screen.getByRole('button', { name: 'Ajouter une condition' });
      const tabStopsOfOneCondition = 10;
      for (let stop = 0; stop < tabStopsOfOneCondition && document.activeElement !== addButton; stop++) await userEvent.tab();

      expect(addButton).toHaveFocus();
    });
  });

  describe('the daemon stays the authority', () => {
    it('shows the refusal of the daemon and keeps the conditions typed in the form', async () => {
      const updateTrigger = vi.fn(() => Promise.reject(new ApiError(400, 'the path "event.row.x" is not a field of a session_state event', 'trigger_field_prefix')));
      await renderTriggers({ triggers: [trigger({ conditions: [idleCondition] })], api: { updateTrigger } });
      await choose(FIRST);
      await openEditor();
      await replaceText('Chemin de la condition 1', 'error');

      await save();

      expect(await screen.findByTestId('write-error')).toBeInTheDocument();
      expect(textbox('Chemin de la condition 1')).toHaveValue('error');
    });

    it('keeps the conditions typed in the second trigger when the save of the first comes back late', async () => {
      const saveAnswer = deferred<TriggerView>();
      const second = trigger({ id: 't2', title: SECOND, conditions: [condition('d1', { rhs: 'second' })] });
      const { fixture } = await renderTriggers({ triggers: [trigger({ conditions: [idleCondition] }), second], api: { updateTrigger: vi.fn(() => saveAnswer.promise) } });
      await choose(FIRST);
      await openEditor();
      await save();
      await choose(SECOND);
      await openEditor();
      await replaceText('Valeur de la condition 1', 'typed');

      saveAnswer.resolve(trigger());
      await letPendingAnswersLand(fixture);

      expect(textbox('Valeur de la condition 1')).toHaveValue('typed');
    });

    it('saves against the revision and the conditions the form was opened from when the list moved on meanwhile', async () => {
      const armAnswer = deferred<TriggerView>();
      let changedElsewhere = false;
      const second = (revision: number, rhs: string) => trigger({ id: 't2', title: SECOND, contentRev: revision, conditions: [condition('d1', { rhs })] });
      const listTriggers = vi.fn(() => Promise.resolve([trigger(), changedElsewhere ? second(6, 'elsewhere') : second(5, 'opened')]));
      const { api, fixture } = await renderTriggers({ api: { listTriggers, armTrigger: vi.fn(() => armAnswer.promise) } });
      await choose(FIRST);
      await userEvent.click(screen.getByRole('button', { name: 'Armer la révision 2' }));
      await letPendingAnswersLand(fixture);
      await choose(SECOND);
      await openEditor();
      changedElsewhere = true;
      armAnswer.resolve(trigger());
      await letPendingAnswersLand(fixture);
      await replaceText('Valeur de la condition 1', 'mine');

      await save();

      expect(lastUpdate(api)).toMatchObject({ triggerId: 't2', expectedRev: 5, changes: { conditions: [{ id: 'd1', rhs: 'mine' }] } });
    });
  });

  describe('the review before arming', () => {
    it('shows the conditions just saved, with their join, path, operator, value, case flag and id', async () => {
      let isSaved = false;
      const savedConditions = [idleCondition, condition('c2', { join: 'or', lhs: 'event.session.error', rhs: 'boom', caseInsensitive: true })];
      const listTriggers = vi.fn(() => Promise.resolve([isSaved ? trigger({ contentRev: 3, conditions: savedConditions }) : trigger({ conditions: [idleCondition] })]));
      const updateTrigger = vi.fn(() => { isSaved = true; return Promise.resolve(trigger({ contentRev: 3, conditions: savedConditions })); });
      await renderTriggers({ api: { listTriggers, updateTrigger } });
      await choose(FIRST);
      await openEditor();
      await addCondition();
      await replaceText('Chemin de la condition 2', 'error');

      await save();

      const review = await screen.findByTestId('review-fields');
      expect(review).toHaveTextContent('Condition 2');
      expect(review).toHaveTextContent('or · event.session.error eq "boom" · casse ignorée : oui · id c2');
    });
  });
});
