import type { TriggerWhen } from '@openfleet/shared';
import { screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../core/fleet-api.service';
import type { TriggerView } from '../core/playbook-trigger-views';
import { FIRST, armed, choose, deferred, letPendingAnswersLand, managerOf, openEditor, renderTriggers, save, sessionOf, trigger } from './triggers-spec-support';
const textbox = (name: string) => screen.getByRole('textbox', { name });
const combobox = (name: string) => screen.getByRole('combobox', { name });
const replaceText = async (name: string, text: string) => { await userEvent.clear(textbox(name)); await userEvent.type(textbox(name), text); };
const chooseOption = (name: string, option: string) => userEvent.selectOptions(combobox(name), option);

type UpdateCall = { triggerId: string; expectedRev: number; changes: { when?: unknown; ownerManagerId?: string | null } };
const lastUpdate = (api: { updateTrigger: ReturnType<typeof vi.fn> }) => api.updateTrigger.mock.calls.at(-1)![0] as UpdateCall;

describe('Trigger editor: the WHEN', () => {
  it('opens on the source and the parameters as stored', async () => {
    await renderTriggers({ triggers: [trigger({ when: { source: 'session_state', state: 'waiting_permission', minutes: 7 } })] });
    await choose(FIRST);

    await openEditor();

    expect(combobox('Source')).toHaveValue('session_state');
    expect(combobox('État de la session')).toHaveValue('waiting_permission');
    expect(textbox('Minutes')).toHaveValue('7');
  });

  it('sends no WHEN when the human left it as stored', async () => {
    const { api } = await renderTriggers();
    await choose(FIRST);
    await openEditor();
    await userEvent.type(textbox('Titre'), '!');

    await save();

    expect(lastUpdate(api).changes).not.toHaveProperty('when');
  });

  it.each<[string, TriggerWhen, () => Promise<void>]>([
    ['session_state', { source: 'session_state', state: 'idle', minutes: 15 }, async () => { await replaceText('Minutes', '15'); }],
    ['session_state closed_with_error', { source: 'session_state', state: 'closed_with_error' }, async () => { await chooseOption('État de la session', 'closed_with_error'); }],
    ['silent_run', { source: 'silent_run', minutes: 20 }, async () => { await chooseOption('Source', 'silent_run'); await replaceText('Minutes', '20'); }],
    ['data_store_query new rows', { source: 'data_store_query', storeId: 's1', event: 'new_matching_rows' }, async () => {
      await chooseOption('Source', 'data_store_query'); await replaceText('Identifiant de la table', 's1');
    }],
    ['data_store_query row_count', { source: 'data_store_query', storeId: 's1', event: 'row_count', op: 'gte', value: 3 }, async () => {
      await chooseOption('Source', 'data_store_query'); await replaceText('Identifiant de la table', 's1');
      await chooseOption('Événement de la table', 'row_count'); await chooseOption('Opérateur', 'gte'); await replaceText('Seuil', '3');
    }],
    ['cron', { source: 'cron', expression: '*/5 * * * *', timezone: 'Europe/London', catchUp: 'run_once' }, async () => {
      await chooseOption('Source', 'cron'); await replaceText('Expression cron', '*/5 * * * *'); await replaceText('Fuseau horaire', 'Europe/London'); await chooseOption('Rattrapage', 'run_once');
    }],
    ['integration_records field_changed', { source: 'integration_records', itemId: 'i1', event: 'field_changed', field: 'status' }, async () => {
      await chooseOption('Source', 'integration_records'); await replaceText("Identifiant de l'intégration", 'i1');
      await chooseOption("Événement de l'intégration", 'field_changed'); await replaceText('Champ suivi', 'status');
    }],
  ])('sends the WHEN of a %s trigger, against the revision it was opened from', async (_label, expectedWhen, fillForm) => {
    const { api } = await renderTriggers();
    await choose(FIRST);
    await openEditor();

    await fillForm();
    await save();

    expect(lastUpdate(api)).toMatchObject({ triggerId: 't1', expectedRev: 2, changes: { when: expectedWhen } });
  });

  it('leaves out the fields that belong to another event of the same source', async () => {
    const { api } = await renderTriggers({ triggers: [trigger({ when: { source: 'data_store_query', storeId: 's1', event: 'row_count', op: 'gt', value: 2 } })] });
    await choose(FIRST);
    await openEditor();

    await chooseOption('Événement de la table', 'row_updated');
    await save();

    expect(lastUpdate(api).changes.when).toEqual({ source: 'data_store_query', storeId: 's1', event: 'row_updated' });
  });

  it.each([
    ['0 minutes', 'Minutes', '0'],
    ['more minutes than a week', 'Minutes', '10081'],
    ['minutes that are not a whole number', 'Minutes', '1.5'],
    ['no minutes for an idle session', 'Minutes', ''],
  ])('refuses %s without calling the daemon', async (_label, fieldName, value) => {
    const { api } = await renderTriggers();
    await choose(FIRST);
    await openEditor();

    await userEvent.clear(textbox(fieldName));
    if (value !== '') await userEvent.type(textbox(fieldName), value);

    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    expect(screen.getByTestId('editor-problem')).toHaveTextContent('Quand');
    expect(api.updateTrigger).not.toHaveBeenCalled();
  });

  it('accepts the bounds of the minutes, 1 and 10080', async () => {
    await renderTriggers();
    await choose(FIRST);
    await openEditor();

    await replaceText('Minutes', '1');
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
    await replaceText('Minutes', '10080');
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
  });

  it.each([
    ['a cron expression that never fires', 'Expression cron', '0 0 30 2 *'],
    ['a cron expression of four fields', 'Expression cron', '* * * *'],
    ['an unknown time zone', 'Fuseau horaire', 'Mars/Olympus'],
  ])('refuses %s without calling the daemon', async (_label, fieldName, value) => {
    const { api } = await renderTriggers({ triggers: [trigger({ when: { source: 'cron', expression: '0 9 * * *', timezone: 'Europe/Paris', catchUp: 'skip' } })] });
    await choose(FIRST);
    await openEditor();

    await replaceText(fieldName, value);

    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    expect(screen.getByTestId('editor-problem')).toBeInTheDocument();
    expect(api.updateTrigger).not.toHaveBeenCalled();
  });

  it('refuses a row count without its threshold and a changed field without its name', async () => {
    await renderTriggers({ triggers: [trigger({ when: { source: 'data_store_query', storeId: 's1', event: 'new_matching_rows' } })] });
    await choose(FIRST);
    await openEditor();

    await chooseOption('Événement de la table', 'row_count');
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();

    await chooseOption('Source', 'integration_records');
    await replaceText("Identifiant de l'intégration", 'i1');
    await chooseOption("Événement de l'intégration", 'field_changed');
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    await replaceText('Champ suivi', 'status');
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
  });

  it('shows what it cannot edit instead of dropping it: a source it does not know is neither shown as a form nor sent', async () => {
    const futureWhen = { source: 'webhook', url: 'x' } as unknown as TriggerWhen;
    const { api } = await renderTriggers({ triggers: [trigger({ when: futureWhen })] });
    await choose(FIRST);
    await openEditor();
    await userEvent.type(textbox('Titre'), '!');

    expect(screen.getByTestId('when-not-editable')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
    await save();

    expect(lastUpdate(api).changes).not.toHaveProperty('when');
  });

  it('does not rebuild a WHEN that holds a field it does not know, so the field is not dropped silently', async () => {
    const whenWithExtraField = { source: 'silent_run', minutes: 5, newerField: true } as unknown as TriggerWhen;
    const { api } = await renderTriggers({ triggers: [trigger({ when: whenWithExtraField })] });
    await choose(FIRST);
    await openEditor();
    await userEvent.type(textbox('Titre'), '!');

    expect(screen.getByTestId('when-not-editable')).toBeInTheDocument();
    await save();

    expect(lastUpdate(api).changes).not.toHaveProperty('when');
  });

  it('renders typed text as text: markup in the expression creates no element', async () => {
    await renderTriggers({ triggers: [trigger({ when: { source: 'cron', expression: '0 9 * * *', timezone: 'Europe/Paris', catchUp: 'skip' } })] });
    await choose(FIRST);
    await openEditor();

    await replaceText('Expression cron', '<img src=x onerror=alert(1)>');

    expect(document.querySelector('img')).toBeNull();
    expect(textbox('Expression cron')).toHaveValue('<img src=x onerror=alert(1)>');
  });
});

describe('Trigger editor: the owner', () => {
  const sessions = [
    managerOf('m1', 'Capitaine'),
    managerOf('m2', 'Second'),
    managerOf('m9', 'Autre projet', 'p2'),
    sessionOf({ id: 'w1', name: 'Ouvrier', role: undefined }),
  ];

  it('offers no manager but those of the project, and an option for none', async () => {
    await renderTriggers({ sessions });
    await choose(FIRST);

    await openEditor();

    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(options).toEqual(expect.arrayContaining(['Capitaine', 'Second', 'Aucun manager']));
    expect(options).not.toContain('Autre projet');
    expect(options).not.toContain('Ouvrier');
  });

  it('has no field to type an id: the owner is only chosen in the list', async () => {
    await renderTriggers({ sessions });
    await choose(FIRST);

    await openEditor();

    expect(screen.queryByRole('textbox', { name: /Propriétaire/ })).toBeNull();
    expect(combobox('Propriétaire')).toHaveValue('m1');
  });

  it('sends the owner chosen, and null for no manager', async () => {
    const { api } = await renderTriggers({ sessions });
    await choose(FIRST);
    await openEditor();
    await screen.findByRole('option', { name: 'Second' });

    await chooseOption('Propriétaire', 'Second');
    await save();
    expect(lastUpdate(api).changes.ownerManagerId).toBe('m2');

    await choose(FIRST);
    await openEditor();
    await screen.findByRole('option', { name: 'Second' });
    await chooseOption('Propriétaire', 'Aucun manager');
    await save();
    expect(lastUpdate(api).changes.ownerManagerId).toBeNull();
  });

  it('sends no owner when the human left it as stored', async () => {
    const { api } = await renderTriggers({ sessions });
    await choose(FIRST);
    await openEditor();
    await screen.findByRole('option', { name: 'Second' });
    await userEvent.type(textbox('Titre'), '!');

    await save();

    expect(lastUpdate(api).changes).not.toHaveProperty('ownerManagerId');
  });

  it('shows an owner that is not a manager of the project as such, and never sends it again', async () => {
    const { api } = await renderTriggers({ sessions, triggers: [trigger({ ownerManagerId: 'm9' })] });
    await choose(FIRST);
    await openEditor();
    await screen.findByRole('option', { name: 'Second' });

    expect(screen.getByRole('option', { name: /introuvable parmi les managers du projet/ })).toBeInTheDocument();
    await chooseOption('Propriétaire', 'Capitaine');
    expect(combobox('Propriétaire')).toHaveValue('m1');
    await save();

    expect(lastUpdate(api).changes.ownerManagerId).toBe('m1');
  });

  it('writes the name of a manager as text, with control characters escaped', async () => {
    await renderTriggers({ sessions: [managerOf('m1', 'Capitaine'), managerOf('m2', '<img src=x>‮evil')] });
    await choose(FIRST);

    await openEditor();

    await screen.findByRole('option', { name: /evil/ });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('option', { name: '<img src=x>\\u202eevil' })).toBeInTheDocument();
  });

  it('says the managers cannot be listed, keeps the owner as stored and lets the rest be saved', async () => {
    const listSessions = vi.fn(() => Promise.reject(new ApiError(500, 'boom')));
    const { api } = await renderTriggers({ api: { listSessions } });
    await choose(FIRST);

    await openEditor();

    expect(await screen.findByTestId('owner-unavailable')).toBeInTheDocument();
    expect(combobox('Propriétaire')).toBeDisabled();
    await userEvent.type(textbox('Titre'), '!');
    await save();
    expect(lastUpdate(api).changes).not.toHaveProperty('ownerManagerId');
  });

  it('lists the managers again when the human asks to retry', async () => {
    const listSessions = vi.fn().mockRejectedValueOnce(new ApiError(500, 'boom')).mockResolvedValue(sessions);
    await renderTriggers({ api: { listSessions } });
    await choose(FIRST);
    await openEditor();
    await screen.findByTestId('owner-unavailable');

    await userEvent.click(screen.getByRole('button', { name: 'Réessayer les managers' }));

    expect(await screen.findByRole('option', { name: 'Second' })).toBeInTheDocument();
    expect(combobox('Propriétaire')).toBeEnabled();
  });

  it('ignores a list of managers that arrives after the form was closed and opened again for another trigger', async () => {
    const firstAnswer = deferred<ReturnType<typeof managerOf>[]>();
    const listSessions = vi.fn().mockReturnValueOnce(firstAnswer.promise).mockResolvedValue([managerOf('m1', 'Capitaine')]);
    const second = trigger({ id: 't2', title: 'Surveiller la table' });
    const { fixture } = await renderTriggers({ api: { listSessions }, triggers: [trigger(), second] });
    await choose(FIRST);
    await openEditor();
    await choose('Surveiller la table');
    await openEditor();
    await screen.findByRole('option', { name: 'Capitaine' });

    firstAnswer.resolve([managerOf('m1', 'Capitaine'), managerOf('m7', 'Fantôme')]);
    await letPendingAnswersLand(fixture);

    expect(screen.queryByRole('option', { name: 'Fantôme' })).toBeNull();
  });

  it('ignores a list of managers that arrives after the form was closed and opened again', async () => {
    const lateAnswer = deferred<ReturnType<typeof managerOf>[]>();
    const listSessions = vi.fn().mockReturnValueOnce(lateAnswer.promise).mockResolvedValue([managerOf('m1', 'Capitaine')]);
    const { fixture } = await renderTriggers({ api: { listSessions } });
    await choose(FIRST);
    await openEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await openEditor();
    await screen.findByRole('option', { name: 'Capitaine' });

    lateAnswer.resolve([managerOf('m1', 'Capitaine'), managerOf('m7', 'Fantôme')]);
    await letPendingAnswersLand(fixture);

    expect(screen.queryByRole('option', { name: 'Fantôme' })).toBeNull();
  });
});

describe('Trigger editor: saving', () => {
  it('sends the revision the form was opened from, not the one the list shows since', async () => {
    const armAnswer = deferred<TriggerView>();
    let secondMovedElsewhere = false;
    const second = (contentRev: number) => trigger({ id: 't2', title: 'Surveiller la table', contentRev });
    const listTriggers = vi.fn(() => Promise.resolve([trigger(), secondMovedElsewhere ? second(6) : second(5)]));
    const { api, fixture } = await renderTriggers({ api: { listTriggers, armTrigger: vi.fn(() => armAnswer.promise) } });
    await choose(FIRST);
    await userEvent.click(screen.getByRole('button', { name: 'Armer la révision 2' }));
    await letPendingAnswersLand(fixture);
    await choose('Surveiller la table');
    await openEditor();
    await replaceText('Minutes', '30');
    secondMovedElsewhere = true;

    armAnswer.resolve(armed());
    await letPendingAnswersLand(fixture);
    await save();

    expect(lastUpdate(api)).toMatchObject({ triggerId: 't2', expectedRev: 5, changes: { when: { source: 'session_state', state: 'idle', minutes: 30 } } });
  });

  it('keeps every typed value, the WHEN and the owner included, when the daemon answers 400', async () => {
    const updateTrigger = vi.fn(() => Promise.reject(new ApiError(400, 'bad', 'invalid_body')));
    await renderTriggers({ api: { updateTrigger }, sessions: [managerOf('m1', 'Capitaine'), managerOf('m2', 'Second')] });
    await choose(FIRST);
    await openEditor();
    await screen.findByRole('option', { name: 'Second' });
    await chooseOption('Source', 'silent_run');
    await replaceText('Minutes', '20');
    await chooseOption('Propriétaire', 'Second');

    await save();

    expect(await screen.findByRole('alert')).toHaveTextContent('The daemon rejected these values');
    expect(combobox('Source')).toHaveValue('silent_run');
    expect(textbox('Minutes')).toHaveValue('20');
    expect(combobox('Propriétaire')).toHaveValue('m2');
  });

  it('says the armed trigger is disarmed and has to be read again once the daemon accepted the change', async () => {
    let isSaved = false;
    const listTriggers = vi.fn(() => Promise.resolve([isSaved ? trigger({ contentRev: 3, reviewDigest: 'digest-3' }) : armed()]));
    const updateTrigger = vi.fn(() => { isSaved = true; return Promise.resolve(trigger({ contentRev: 3 })); });
    const { fixture } = await renderTriggers({ api: { listTriggers, updateTrigger } });
    await choose(FIRST);
    await openEditor();
    await replaceText('Minutes', '30');

    await save();
    await screen.findByTestId('edit-saved-notice');
    await fixture.whenStable();

    expect(screen.getByTestId('edit-saved-notice')).toHaveTextContent('désarmé, à relire');
    expect(screen.getByTestId('trigger-arming-pill')).toHaveTextContent('Désarmé');
  });

  it('puts the focus on the title when the form opens', async () => {
    const { fixture } = await renderTriggers();
    await choose(FIRST);

    await openEditor();
    await fixture.whenStable();

    expect(document.activeElement).toBe(textbox('Titre'));
  });
});
