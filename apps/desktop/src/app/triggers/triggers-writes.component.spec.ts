import type { Project, TriggerFireView } from '@openfleet/shared';
import type { ComponentFixture } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { OperatorNonceMinter } from '../core/operator-nonce-minter';
import type { TriggerView } from '../core/playbook-trigger-views';
import { TriggersViewComponent } from './triggers-view.component';

const PROJECT = { id: 'p1', name: 'Alpha' } as Project;
const FIRST = 'Réveiller Capitaine';
const SECOND = 'Surveiller la table';

const trigger = (overrides: Partial<TriggerView> = {}): TriggerView => ({
  id: 't1', projectId: 'p1', ownerManagerId: 'm1', title: FIRST, when: { source: 'session_state', state: 'idle', minutes: 10 }, conditions: [],
  run: { kind: 'notify', title: 'Inactive', message: 'Une session dort.' }, policy: { cooldownSeconds: 0, batchMode: 'per_event', backlogPolicy: 'fire_all', backlogMaxAgeMinutes: 45 },
  contentRev: 2, armedAt: null, approvedRev: null, approvedGraphDigest: null, reviewDigest: 'digest-2', updatedAt: '2026-11-05T10:00:00Z', ...overrides,
});
const secondTrigger = (overrides: Partial<TriggerView> = {}) => trigger({ id: 't2', title: SECOND, contentRev: 5, reviewDigest: 'digest-5', ...overrides });
const armed = (overrides: Partial<TriggerView> = {}) => trigger({ armedAt: '2026-11-05T12:00:00Z', approvedRev: 2, approvedGraphDigest: 'digest-2', ...overrides });

type FakeApi = Partial<Record<keyof FleetApiService, ReturnType<typeof vi.fn>>>;

const staleRevision = () => new ApiError(409, 'conflict', 'stale_revision');

/** An answer the test settles itself, in the order it wants. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

/** Barrier: a zero-delay macrotask runs after every queued microtask, so each pending answer has been consumed; then Angular renders. */
async function letPendingAnswersLand(fixture: ComponentFixture<unknown>): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await fixture.whenStable();
}

async function renderTriggers({ api: overrides = {}, nonce = vi.fn(() => Promise.resolve('nonce-1')), triggers = [trigger()] }: { api?: FakeApi; nonce?: ReturnType<typeof vi.fn>; triggers?: TriggerView[] } = {}) {
  const api = {
    listProjects: vi.fn(() => Promise.resolve({ items: [PROJECT], total: 1, limit: 200, offset: 0 })),
    listPlaybooks: vi.fn(() => Promise.resolve([])),
    listTriggers: vi.fn(() => Promise.resolve(triggers)),
    listTriggerFires: vi.fn(() => Promise.resolve([] as TriggerFireView[])),
    getTrigger: vi.fn((id: string) => Promise.resolve(triggers.find((candidate) => candidate.id === id)!)),
    armTrigger: vi.fn(() => Promise.resolve(armed())),
    disarmTrigger: vi.fn(() => Promise.resolve(trigger())),
    updateTrigger: vi.fn(() => Promise.resolve(trigger())),
    ...overrides,
  };
  const minter = { mintTriggerArmingNonce: nonce };
  const { fixture } = await render(TriggersViewComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: OperatorNonceMinter, useValue: minter }] });
  await userEvent.click(screen.getByRole('tab', { name: 'Triggers' }));
  return { api, minter, fixture };
}

const choose = async (title: string) => userEvent.click(await screen.findByRole('button', { name: new RegExp(title) }));
const arm = (rev: number) => userEvent.click(screen.getByRole('button', { name: `Armer la révision ${rev}` }));
const heading = (title: string) => screen.getByRole('heading', { name: title });

describe('Triggers: review before arming', () => {
  it('shows the digest to approve as read-only text beside the whole rule', async () => {
    await renderTriggers();

    await choose(FIRST);

    expect(screen.getByTestId('review-digest')).toHaveTextContent('digest-2');
    expect(screen.getByTestId('trigger-detail')).toHaveTextContent('Propriétaire');
    expect(screen.queryByRole('textbox', { name: /empreinte|digest/i })).toBeNull();
  });

  it('says the digest is unavailable when the daemon sends none', async () => {
    await renderTriggers({ triggers: [trigger({ reviewDigest: undefined })] });

    await choose(FIRST);

    expect(screen.getByTestId('review-digest')).toHaveTextContent('indisponible');
  });

  it('arms the revision the human reviewed with the proof of the shell, and sends no digest', async () => {
    const { api, minter } = await renderTriggers();
    await choose(FIRST);

    await arm(2);

    expect(minter.mintTriggerArmingNonce).toHaveBeenCalledWith('t1');
    expect(api.armTrigger).toHaveBeenCalledWith({ triggerId: 't1', approvedRev: 2, humanProof: 'nonce-1' });
  });

  it('reads the trigger again before it arms', async () => {
    const { api } = await renderTriggers();
    await choose(FIRST);

    await arm(2);

    expect(api.getTrigger).toHaveBeenCalledWith('t1');
  });

  it('does not arm, asks for no proof and reloads when the revision read again is not the one reviewed', async () => {
    let movedElsewhere = false;
    const listTriggers = vi.fn(() => Promise.resolve([movedElsewhere ? trigger({ contentRev: 3, reviewDigest: 'digest-3' }) : trigger()]));
    const getTrigger = vi.fn(() => { movedElsewhere = true; return Promise.resolve(trigger({ contentRev: 3, reviewDigest: 'digest-3' })); });
    const { api, minter } = await renderTriggers({ api: { listTriggers, getTrigger } });
    await choose(FIRST);

    await arm(2);

    expect(await screen.findByRole('alert')).toHaveTextContent('changed since you opened it');
    expect(api.armTrigger).not.toHaveBeenCalled();
    expect(minter.mintTriggerArmingNonce).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Armer la révision 3' })).toBeInTheDocument();
    expect(screen.getByTestId('review-digest')).toHaveTextContent('digest-3');
  });

  it('does not arm when only the digest moved since the human read the rule', async () => {
    const getTrigger = vi.fn(() => Promise.resolve(trigger({ reviewDigest: 'digest-2-bis' })));
    const { api } = await renderTriggers({ api: { getTrigger } });
    await choose(FIRST);

    await arm(2);

    expect(await screen.findByRole('alert')).toHaveTextContent('changed since you opened it');
    expect(api.armTrigger).not.toHaveBeenCalled();
  });

  it('does not arm and says so when the shell cannot give the proof of a human gesture', async () => {
    const { api } = await renderTriggers({ nonce: vi.fn(() => Promise.reject(new Error('arming a trigger needs the desktop app'))) });
    await choose(FIRST);

    await arm(2);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(api.armTrigger).not.toHaveBeenCalled();
  });

  it('shows the refusal of the daemon, reads the list again and keeps the trigger disarmed on screen', async () => {
    const { api } = await renderTriggers({ api: { armTrigger: vi.fn(() => Promise.reject(staleRevision())) } });
    await choose(FIRST);

    await arm(2);

    expect(await screen.findByRole('alert')).toHaveTextContent('changed since you opened it');
    expect(api.listTriggers).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('trigger-arming-pill')).toHaveTextContent('Désarmé');
  });

  it('puts the keyboard focus on the announced error when arming fails', async () => {
    const { fixture } = await renderTriggers({ api: { armTrigger: vi.fn(() => Promise.reject(staleRevision())) } });
    await choose(FIRST);
    await arm(2);

    const announcedError = await screen.findByRole('alert');
    await fixture.whenStable();

    expect(document.activeElement).toBe(announcedError);
  });

  it('shows the trigger armed once the daemon armed it and puts the focus on its heading', async () => {
    let isArmed = false;
    const listTriggers = vi.fn(() => Promise.resolve([isArmed ? armed() : trigger()]));
    const armTrigger = vi.fn(() => { isArmed = true; return Promise.resolve(armed()); });
    const { fixture } = await renderTriggers({ api: { listTriggers, armTrigger } });
    await choose(FIRST);

    await arm(2);
    await screen.findByRole('button', { name: 'Désarmer' });
    await fixture.whenStable();

    expect(screen.getByTestId('trigger-arming-pill')).toHaveTextContent('Armé');
    expect(screen.queryByRole('button', { name: /Armer la révision/ })).toBeNull();
    expect(document.activeElement).toBe(heading(FIRST));
  });

  it('ignores a second click while the first arming is pending', async () => {
    const armAnswer = deferred<TriggerView>();
    const { api, minter, fixture } = await renderTriggers({ api: { armTrigger: vi.fn(() => armAnswer.promise) } });
    await choose(FIRST);
    await arm(2);
    await letPendingAnswersLand(fixture);

    expect(screen.getByRole('button', { name: 'Armer la révision 2' })).toBeDisabled();
    await arm(2);

    expect(minter.mintTriggerArmingNonce).toHaveBeenCalledTimes(1);
    expect(api.armTrigger).toHaveBeenCalledTimes(1);
  });
});

describe('Triggers: disarming', () => {
  it('disarms the trigger and shows it disarmed with the focus on its heading', async () => {
    let isDisarmed = false;
    const listTriggers = vi.fn(() => Promise.resolve([isDisarmed ? trigger() : armed()]));
    const disarmTrigger = vi.fn(() => { isDisarmed = true; return Promise.resolve(trigger()); });
    const { api, fixture } = await renderTriggers({ api: { listTriggers, disarmTrigger } });
    await choose(FIRST);

    await userEvent.click(screen.getByRole('button', { name: 'Désarmer' }));
    await screen.findByRole('button', { name: 'Armer la révision 2' });
    await fixture.whenStable();

    expect(api.disarmTrigger).toHaveBeenCalledWith('t1');
    expect(screen.getByTestId('trigger-arming-pill')).toHaveTextContent('Désarmé');
    expect(document.activeElement).toBe(heading(FIRST));
  });

  it('offers no disarm control for a disarmed trigger', async () => {
    await renderTriggers();

    await choose(FIRST);

    expect(screen.queryByRole('button', { name: 'Désarmer' })).toBeNull();
  });

  it('tells the user when the daemon refuses to disarm and puts the focus on the error', async () => {
    const { fixture } = await renderTriggers({ triggers: [armed()], api: { disarmTrigger: vi.fn(() => Promise.reject(new ApiError(500, 'boom'))) } });
    await choose(FIRST);

    await userEvent.click(screen.getByRole('button', { name: 'Désarmer' }));
    const announcedError = await screen.findByRole('alert');
    await fixture.whenStable();

    expect(document.activeElement).toBe(announcedError);
  });
});

describe('Triggers: the arming pill follows the selection', () => {
  it('says armed when the approved digest is the one that would be recorded now', async () => {
    await renderTriggers({ triggers: [armed()] });

    await choose(FIRST);

    expect(screen.getByTestId('trigger-arming-pill')).toHaveTextContent('Armé');
  });

  it('says the arming lapsed when the digest to review is no longer the approved one, and offers to arm again', async () => {
    await renderTriggers({ triggers: [armed({ reviewDigest: 'digest-2-bis' })] });

    await choose(FIRST);

    expect(screen.getByTestId('trigger-arming-pill')).toHaveTextContent('Armement caduc');
    expect(screen.getByRole('button', { name: 'Armer la révision 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Désarmer' })).toBeInTheDocument();
  });

  it('shows the state of the trigger chosen last', async () => {
    await renderTriggers({ triggers: [armed(), secondTrigger()] });
    await choose(FIRST);
    expect(screen.getByTestId('trigger-arming-pill')).toHaveTextContent('Armé');

    await choose(SECOND);

    expect(screen.getByTestId('trigger-arming-pill')).toHaveTextContent('Désarmé');
    expect(screen.getByRole('button', { name: 'Armer la révision 5' })).toBeInTheDocument();
  });

  it('does not keep the refusal of one trigger under the next one chosen', async () => {
    await renderTriggers({ triggers: [trigger(), secondTrigger()], api: { armTrigger: vi.fn(() => Promise.reject(staleRevision())) } });
    await choose(FIRST);
    await arm(2);
    await screen.findByRole('alert');

    await choose(SECOND);

    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Triggers: answers that arrive after the user moved on', () => {
  async function startArmingFirstTriggerThenChooseSecond(armAnswer: ReturnType<typeof deferred<TriggerView>>) {
    const rendered = await renderTriggers({ triggers: [trigger(), secondTrigger()], api: { armTrigger: vi.fn(() => armAnswer.promise) } });
    await choose(FIRST);
    await arm(2);
    await letPendingAnswersLand(rendered.fixture);
    await choose(SECOND);
    return rendered;
  }

  it('does not show the late refusal of the first trigger under the second', async () => {
    const armAnswer = deferred<TriggerView>();
    const { fixture } = await startArmingFirstTriggerThenChooseSecond(armAnswer);

    armAnswer.reject(staleRevision());
    await letPendingAnswersLand(fixture);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(heading(SECOND)).toBeInTheDocument();
  });

  it('leaves the focus and the detail of the second trigger alone when the first is armed late', async () => {
    const armAnswer = deferred<TriggerView>();
    const { fixture } = await startArmingFirstTriggerThenChooseSecond(armAnswer);
    const buttonOfSecond = screen.getByRole('button', { name: 'Armer la révision 5' });
    buttonOfSecond.focus();

    armAnswer.resolve(armed());
    await letPendingAnswersLand(fixture);

    expect(heading(SECOND)).toBeInTheDocument();
    expect(document.activeElement).toBe(buttonOfSecond);
  });

  it('keeps the controls of the second trigger usable while the first is still being armed', async () => {
    const armAnswer = deferred<TriggerView>();
    await startArmingFirstTriggerThenChooseSecond(armAnswer);

    expect(screen.getByRole('button', { name: 'Armer la révision 5' })).toBeEnabled();
  });

  it('reads the list again for the first trigger armed late, so it shows armed when chosen again', async () => {
    const armAnswer = deferred<TriggerView>();
    let isFirstArmed = false;
    const listTriggers = vi.fn(() => Promise.resolve([isFirstArmed ? armed() : trigger(), secondTrigger()]));
    const { fixture } = await renderTriggers({ api: { listTriggers, armTrigger: vi.fn(() => { isFirstArmed = true; return armAnswer.promise; }) } });
    await choose(FIRST);
    await arm(2);
    await letPendingAnswersLand(fixture);
    await choose(SECOND);

    armAnswer.resolve(armed());
    await letPendingAnswersLand(fixture);
    await choose(FIRST);

    expect(screen.getByTestId('trigger-arming-pill')).toHaveTextContent('Armé');
  });
});

describe('Triggers: edit', () => {
  const openEditor = async () => userEvent.click(await screen.findByRole('button', { name: 'Modifier' }));
  const field = (name: string) => screen.getByRole('textbox', { name });

  it('opens the form with the title and the policy as stored', async () => {
    await renderTriggers({ triggers: [trigger({ policy: { cooldownSeconds: 30, maxFiresPerDay: 4, batchMode: 'per_batch', backlogPolicy: 'discard_stale' } })] });
    await choose(FIRST);

    await openEditor();

    expect(field('Titre')).toHaveValue(FIRST);
    expect(field('Repos (secondes)')).toHaveValue('30');
    expect(field('Plafond de tirs par jour')).toHaveValue('4');
    expect(screen.getByRole('combobox', { name: 'Mode de lot' })).toHaveValue('per_batch');
    expect(screen.getByRole('combobox', { name: 'Arriéré' })).toHaveValue('discard_stale');
  });

  it('warns that saving clears the arming', async () => {
    await renderTriggers({ triggers: [armed()] });
    await choose(FIRST);

    await openEditor();

    expect(screen.getByTestId('trigger-editor')).toHaveTextContent('désarme');
  });

  it('saves the changes against the revision it read and keeps the policy fields it does not edit', async () => {
    const { api } = await renderTriggers();
    await choose(FIRST);
    await openEditor();

    await userEvent.clear(field('Titre'));
    await userEvent.type(field('Titre'), 'Nouveau titre');
    await userEvent.clear(field('Repos (secondes)'));
    await userEvent.type(field('Repos (secondes)'), '30');
    await userEvent.type(field('Plafond de tirs par jour'), '6');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(api.updateTrigger).toHaveBeenCalledWith({
      triggerId: 't1', expectedRev: 2,
      changes: { title: 'Nouveau titre', policy: { cooldownSeconds: 30, maxFiresPerDay: 6, batchMode: 'per_event', backlogPolicy: 'fire_all', backlogMaxAgeMinutes: 45 } },
    });
  });

  it('sends no daily cap when the field is empty', async () => {
    const { api } = await renderTriggers({ triggers: [trigger({ policy: { cooldownSeconds: 0, maxFiresPerDay: 4, batchMode: 'per_event', backlogPolicy: 'fire_all' } })] });
    await choose(FIRST);
    await openEditor();

    await userEvent.clear(field('Plafond de tirs par jour'));
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    const [{ changes }] = api.updateTrigger.mock.calls[0] as [{ changes: { policy: object } }];
    expect(changes.policy).not.toHaveProperty('maxFiresPerDay');
  });

  it.each([
    ['a negative rest', 'Repos (secondes)', '-1'],
    ['a rest that is not a whole number', 'Repos (secondes)', '1.5'],
    ['a daily cap of zero', 'Plafond de tirs par jour', '0'],
    ['a daily cap that is not a number', 'Plafond de tirs par jour', 'abc'],
  ])('refuses %s without calling the daemon', async (_label, fieldName, value) => {
    const { api } = await renderTriggers();
    await choose(FIRST);
    await openEditor();

    await userEvent.clear(field(fieldName));
    await userEvent.type(field(fieldName), value);

    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    expect(screen.getByTestId('editor-problem')).toBeInTheDocument();
    expect(api.updateTrigger).not.toHaveBeenCalled();
  });

  it('shows the saved trigger and puts the focus on its heading', async () => {
    let isSaved = false;
    const listTriggers = vi.fn(() => Promise.resolve([isSaved ? trigger({ title: 'Nouveau titre', contentRev: 3 }) : trigger()]));
    const updateTrigger = vi.fn(() => { isSaved = true; return Promise.resolve(trigger({ title: 'Nouveau titre', contentRev: 3 })); });
    const { fixture } = await renderTriggers({ api: { listTriggers, updateTrigger } });
    await choose(FIRST);
    await openEditor();
    await userEvent.type(field('Titre'), '!');

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await screen.findByRole('heading', { name: 'Nouveau titre' });
    await fixture.whenStable();

    expect(screen.queryByTestId('trigger-editor')).toBeNull();
    expect(document.activeElement).toBe(heading('Nouveau titre'));
  });

  it('tells the user the trigger changed since they opened it, closes the form and reads the list again', async () => {
    const { api, fixture } = await renderTriggers({ api: { updateTrigger: vi.fn(() => Promise.reject(staleRevision())) } });
    await choose(FIRST);
    await openEditor();

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    const announcedError = await screen.findByRole('alert');
    await fixture.whenStable();

    expect(announcedError).toHaveTextContent('changed since you opened it');
    expect(screen.queryByTestId('trigger-editor')).toBeNull();
    expect(api.listTriggers).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(announcedError);
  });

  it('keeps the form open when the failure is not a conflict, so nothing typed is lost', async () => {
    await renderTriggers({ api: { updateTrigger: vi.fn(() => Promise.reject(new ApiError(500, 'boom'))) } });
    await choose(FIRST);
    await openEditor();
    await userEvent.type(field('Titre'), '!');

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(field('Titre')).toHaveValue(`${FIRST}!`);
  });

  it('closes the form on Annuler without calling the daemon and puts the focus on the heading', async () => {
    const { api, fixture } = await renderTriggers();
    await choose(FIRST);
    await openEditor();

    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await fixture.whenStable();

    expect(screen.queryByTestId('trigger-editor')).toBeNull();
    expect(api.updateTrigger).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(heading(FIRST));
  });

  it('closes the form of the first trigger when the second is chosen', async () => {
    await renderTriggers({ triggers: [trigger(), secondTrigger()] });
    await choose(FIRST);
    await openEditor();

    await choose(SECOND);

    expect(screen.queryByTestId('trigger-editor')).toBeNull();
  });

  it('offers a form of its own for the second trigger, not the draft of the first', async () => {
    await renderTriggers({ triggers: [trigger(), secondTrigger()] });
    await choose(FIRST);
    await openEditor();
    await userEvent.type(field('Titre'), '!');
    await choose(SECOND);

    await openEditor();

    expect(field('Titre')).toHaveValue(SECOND);
  });

  it('shows no failure of a save that comes back late under the trigger chosen meanwhile', async () => {
    const saveAnswer = deferred<TriggerView>();
    const { fixture } = await renderTriggers({ triggers: [trigger(), secondTrigger()], api: { updateTrigger: vi.fn(() => saveAnswer.promise) } });
    await choose(FIRST);
    await openEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await choose(SECOND);

    saveAnswer.reject(staleRevision());
    await letPendingAnswersLand(fixture);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(heading(SECOND)).toBeInTheDocument();
  });
});
