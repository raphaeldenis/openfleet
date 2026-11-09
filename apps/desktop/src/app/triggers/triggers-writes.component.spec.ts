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

  describe('the draft keeps the revision it was opened from', () => {
    const policyWithCap = (maxFiresPerDay: number, backlogMaxAgeMinutes: number) =>
      ({ cooldownSeconds: 0, maxFiresPerDay, batchMode: 'per_event', backlogPolicy: 'fire_all', backlogMaxAgeMinutes }) as const;
    const secondAtRevision5 = () => secondTrigger({ contentRev: 5, policy: policyWithCap(4, 45) });
    const secondAtRevision6 = () => secondTrigger({ contentRev: 6, policy: policyWithCap(20, 90) });

    async function openSecondEditorWhileFirstIsBeingArmed() {
      const armAnswer = deferred<TriggerView>();
      let secondChangedElsewhere = false;
      const listTriggers = vi.fn(() => Promise.resolve([trigger(), secondChangedElsewhere ? secondAtRevision6() : secondAtRevision5()]));
      const rendered = await renderTriggers({ api: { listTriggers, armTrigger: vi.fn(() => armAnswer.promise) } });
      await choose(FIRST);
      await arm(2);
      await letPendingAnswersLand(rendered.fixture);
      await choose(SECOND);
      await openEditor();
      secondChangedElsewhere = true;
      return { ...rendered, armAnswer };
    }

    it('saves against the revision the form was opened from when the first trigger is armed late and the list moved on', async () => {
      const { api, fixture, armAnswer } = await openSecondEditorWhileFirstIsBeingArmed();

      armAnswer.resolve(armed());
      await letPendingAnswersLand(fixture);
      await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

      expect(api.updateTrigger).toHaveBeenCalledWith({
        triggerId: 't2', expectedRev: 5, changes: { title: SECOND, policy: policyWithCap(4, 45) },
      });
    });

    it('keeps the values typed in the form when the first trigger is armed late', async () => {
      const { fixture, armAnswer } = await openSecondEditorWhileFirstIsBeingArmed();
      await userEvent.type(field('Titre'), '!');

      armAnswer.resolve(armed());
      await letPendingAnswersLand(fixture);

      expect(field('Titre')).toHaveValue(`${SECOND}!`);
      expect(field('Plafond de tirs par jour')).toHaveValue('4');
    });

    it('keeps the values typed in the form when the first trigger is refused late with a stale revision', async () => {
      const { fixture, armAnswer } = await openSecondEditorWhileFirstIsBeingArmed();
      await userEvent.type(field('Titre'), '!');

      armAnswer.reject(staleRevision());
      await letPendingAnswersLand(fixture);

      expect(field('Titre')).toHaveValue(`${SECOND}!`);
      expect(screen.queryByRole('alert')).toBeNull();
    });
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

describe('Triggers: the review shows everything the digest covers', () => {
  const reviewText = () => screen.getByTestId('review-fields');
  const armButton = () => screen.getByRole('button', { name: 'Armer la révision 2' });
  const longPrompt = `${'a'.repeat(3000)}FIN-DU-PROMPT`;
  const cronWhen = { source: 'cron', expression: '*/7 * * * *', timezone: 'Asia/Tokyo', catchUp: 'run_once' } as const;

  it('shows the owner, the WHEN, each condition, the target and the policy with its backlog age', async () => {
    await renderTriggers({
      triggers: [trigger({
        ownerManagerId: 'owner-m9', when: cronWhen,
        conditions: [
          { id: 'c1', lhs: 'event.slot.hour', op: 'gte', rhs: 1717, join: 'and', caseInsensitive: false },
          { id: 'c2', lhs: 'event.slot.name', op: 'contains', rhs: 'Nuit-distincte', join: 'or', caseInsensitive: true },
        ],
        run: { kind: 'prompt_manager', managerId: 'mgr-42', prompt: 'PROMPT-DISTINCTIF' },
        policy: { cooldownSeconds: 3131, maxFiresPerDay: 6161, batchMode: 'per_batch', backlogPolicy: 'discard_stale', backlogMaxAgeMinutes: 7777 },
      })],
    });

    await choose(FIRST);

    for (const expected of ['owner-m9', '*/7 * * * *', 'Asia/Tokyo', 'run_once', 'event.slot.hour', '1717', 'event.slot.name', 'Nuit-distincte', 'mgr-42', 'PROMPT-DISTINCTIF', '3131', '6161', 'per_batch', 'discard_stale', '7777']) {
      expect(reviewText()).toHaveTextContent(expected, { normalizeWhitespace: true });
    }
  });

  it.each([
    ['a session_state WHEN', { when: { source: 'session_state', state: 'waiting_permission', minutes: 1313 } }, ['waiting_permission', '1313']],
    ['a silent_run WHEN', { when: { source: 'silent_run', minutes: 2929 } }, ['2929']],
    ['a data_store_query WHEN', { when: { source: 'data_store_query', storeId: 'store-xyz', event: 'row_count', op: 'gt', value: 4747 } }, ['store-xyz', 'row_count', 'gt', '4747']],
    ['an integration_records WHEN', { when: { source: 'integration_records', itemId: 'item-q', event: 'field_changed', field: 'statut-distinct' } }, ['item-q', 'field_changed', 'statut-distinct']],
    ['a notify RUN', { run: { kind: 'notify', title: 'TITRE-DISTINCT', message: 'MESSAGE-DISTINCT' } }, ['TITRE-DISTINCT', 'MESSAGE-DISTINCT']],
    ['a prompt_session RUN', { run: { kind: 'prompt_session', sessionId: 'session-s7', prompt: 'PROMPT-SESSION-DISTINCT' } }, ['session-s7', 'PROMPT-SESSION-DISTINCT']],
    ['a close_session RUN', { run: { kind: 'close_session', sessionId: 'session-s8' } }, ['session-s8']],
    ['a run_playbook RUN with inputs', { run: { kind: 'run_playbook', playbookId: 'pb-9', inputs: { cle: 'VALEUR-INPUT', imbrique: { n: 8484 } } } }, ['pb-9', 'cle', 'VALEUR-INPUT', 'imbrique', '8484']],
  ] satisfies [string, Partial<TriggerView>, string[]][])('shows every parameter of %s', async (_label, overrides, expectedTexts) => {
    await renderTriggers({ triggers: [trigger(overrides)] });

    await choose(FIRST);

    for (const expected of expectedTexts) expect(reviewText()).toHaveTextContent(expected, { normalizeWhitespace: true });
  });

  it('shows text that looks like HTML as plain text', async () => {
    await renderTriggers({ triggers: [trigger({ run: { kind: 'prompt_manager', prompt: '<img src="x" alt="piege"><b>gras</b>' } })] });

    await choose(FIRST);

    expect(reviewText().querySelector('img')).toBeNull();
    expect(reviewText().querySelector('b')).toBeNull();
    expect(reviewText()).toHaveTextContent('<img src="x" alt="piege"><b>gras</b>');
  });

  it('writes control and direction characters as their code', async () => {
    await renderTriggers({ triggers: [trigger({ run: { kind: 'prompt_manager', prompt: 'avant‮apres\u001bfin' } })] });

    await choose(FIRST);

    expect(reviewText()).toHaveTextContent('avant\\u202eapres\\u001bfin');
  });

  describe('a text too long to show in full', () => {
    const triggerWithLongPrompt = (overrides: Partial<TriggerView> = {}) => trigger({ run: { kind: 'prompt_manager', prompt: longPrompt }, ...overrides });

    it('is cut with the number of hidden characters said, and offers to read it all', async () => {
      await renderTriggers({ triggers: [triggerWithLongPrompt()] });

      await choose(FIRST);

      expect(reviewText()).not.toHaveTextContent('FIN-DU-PROMPT');
      expect(reviewText()).toHaveTextContent(/\d+ caractères masqués/);
      expect(screen.getByRole('button', { name: /Tout lire.*prompt/i })).toBeInTheDocument();
    });

    it('is shown in full once the human asks to read it all', async () => {
      await renderTriggers({ triggers: [triggerWithLongPrompt()] });
      await choose(FIRST);

      await userEvent.click(screen.getByRole('button', { name: /Tout lire.*prompt/i }));

      expect(reviewText()).toHaveTextContent('FIN-DU-PROMPT');
      expect(reviewText()).not.toHaveTextContent('caractères masqués');
    });

    it('keeps Armer disabled and says why until the human has read it all', async () => {
      await renderTriggers({ triggers: [triggerWithLongPrompt()] });
      await choose(FIRST);

      expect(armButton()).toBeDisabled();
      expect(screen.getByTestId('arm-blocked')).toHaveTextContent(/lire/i);

      await userEvent.click(screen.getByRole('button', { name: /Tout lire.*prompt/i }));

      expect(armButton()).toBeEnabled();
      expect(screen.queryByTestId('arm-blocked')).toBeNull();
    });

    it('does not count what was read on one trigger as read on the next', async () => {
      await renderTriggers({ triggers: [triggerWithLongPrompt(), triggerWithLongPrompt({ id: 't2', title: SECOND, contentRev: 5, reviewDigest: 'digest-5' })] });
      await choose(FIRST);
      await userEvent.click(screen.getByRole('button', { name: /Tout lire.*prompt/i }));

      await choose(SECOND);

      expect(screen.getByRole('button', { name: 'Armer la révision 5' })).toBeDisabled();
    });

    it('asks to read it again when the same trigger comes back on a new revision', async () => {
      let movedElsewhere = false;
      const revisionThree = () => triggerWithLongPrompt({ contentRev: 3, reviewDigest: 'digest-3' });
      const listTriggers = vi.fn(() => Promise.resolve([movedElsewhere ? revisionThree() : triggerWithLongPrompt()]));
      const getTrigger = vi.fn(() => { movedElsewhere = true; return Promise.resolve(revisionThree()); });
      await renderTriggers({ api: { listTriggers, getTrigger } });
      await choose(FIRST);
      await userEvent.click(screen.getByRole('button', { name: /Tout lire.*prompt/i }));
      await userEvent.click(armButton());
      await screen.findByRole('alert');

      expect(screen.getByRole('button', { name: 'Armer la révision 3' })).toBeDisabled();
    });
  });

  describe('a field the screen cannot show', () => {
    const futureRun = { kind: 'send_pigeon', coop: 'nord' } as unknown as TriggerView['run'];
    const noteWithUnknownField = { kind: 'notify', title: 'Inactive', message: 'Une session dort.', channel: 'sms' } as unknown as TriggerView['run'];

    it.each([
      ['a RUN kind it does not know', futureRun, 'send_pigeon'],
      ['a field of the RUN it does not know', noteWithUnknownField, 'channel'],
    ])('keeps Armer disabled and names the cause for %s', async (_label, run, culprit) => {
      await renderTriggers({ triggers: [trigger({ run })] });

      await choose(FIRST);

      expect(armButton()).toBeDisabled();
      expect(screen.getByTestId('arm-blocked')).toHaveTextContent(culprit);
    });

    it('keeps Armer disabled for a WHEN source it does not know', async () => {
      const futureWhen = { source: 'telepathy', range: 'long' } as unknown as TriggerView['when'];
      await renderTriggers({ triggers: [trigger({ when: futureWhen })] });

      await choose(FIRST);

      expect(armButton()).toBeDisabled();
      expect(screen.getByTestId('arm-blocked')).toHaveTextContent('telepathy');
    });

    it('keeps Armer disabled for a policy field it does not know', async () => {
      const futurePolicy = { cooldownSeconds: 0, batchMode: 'per_event', backlogPolicy: 'fire_all', jitter: 3 } as unknown as TriggerView['policy'];
      await renderTriggers({ triggers: [trigger({ policy: futurePolicy })] });

      await choose(FIRST);

      expect(armButton()).toBeDisabled();
      expect(screen.getByTestId('arm-blocked')).toHaveTextContent('jitter');
    });

    it('keeps Armer disabled for a condition field it does not know', async () => {
      const futureCondition = { id: 'c1', lhs: 'event.session.state', op: 'eq', rhs: 'idle', join: 'and', caseInsensitive: false, weight: 2 } as unknown as TriggerView['conditions'][number];
      await renderTriggers({ triggers: [trigger({ conditions: [futureCondition] })] });

      await choose(FIRST);

      expect(armButton()).toBeDisabled();
      expect(screen.getByTestId('arm-blocked')).toHaveTextContent('weight');
    });
  });
});

describe('Triggers: the state after a write whose confirmation could not be read', () => {
  const unreadable = () => Promise.reject(new ApiError(500, 'boom'));
  /** Serves the answers of the list in order; the last one is served again. */
  const listAnswering = (...answers: Array<() => Promise<TriggerView[]>>) => {
    let served = 0;
    return vi.fn(() => answers[Math.min(served++, answers.length - 1)]!());
  };
  const list = (...triggers: TriggerView[]) => () => Promise.resolve(triggers);
  const pill = () => screen.getByTestId('trigger-arming-pill');
  const armButtonOf = (rev: number) => screen.queryByRole('button', { name: `Armer la révision ${rev}` });
  const reloadButton = () => screen.findByRole('button', { name: 'Recharger' });

  it('says the state is unknown after an arming whose list could not be read, and offers to reload', async () => {
    await renderTriggers({ api: { listTriggers: listAnswering(list(trigger()), unreadable) } });
    await choose(FIRST);

    await arm(2);
    await reloadButton();

    expect(pill()).toHaveTextContent('État inconnu — recharger');
    expect(pill()).not.toHaveTextContent('Désarmé');
    expect(armButtonOf(2)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Modifier' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Désarmer' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Triggers' })).toHaveTextContent('État inconnu');
  });

  it('shows the real state once the human reloads and the list is read', async () => {
    await renderTriggers({ api: { listTriggers: listAnswering(list(trigger()), unreadable, list(armed())) } });
    await choose(FIRST);
    await arm(2);

    await userEvent.click(await reloadButton());

    await screen.findByRole('button', { name: 'Désarmer' });
    expect(pill()).toHaveTextContent('Armé');
    expect(screen.queryByRole('button', { name: 'Recharger' })).toBeNull();
  });

  it('stays unknown and announces the failure when the reload cannot be read either', async () => {
    await renderTriggers({ api: { listTriggers: listAnswering(list(trigger()), unreadable, unreadable) } });
    await choose(FIRST);
    await arm(2);

    await userEvent.click(await reloadButton());

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(pill()).toHaveTextContent('État inconnu — recharger');
  });

  it('offers to disarm, and nothing to arm, when a disarming could not be confirmed', async () => {
    await renderTriggers({ triggers: [armed()], api: { listTriggers: listAnswering(list(armed()), unreadable) } });
    await choose(FIRST);

    await userEvent.click(screen.getByRole('button', { name: 'Désarmer' }));
    await reloadButton();

    expect(pill()).toHaveTextContent('État inconnu — recharger');
    expect(screen.getByRole('button', { name: 'Désarmer' })).toBeInTheDocument();
    expect(armButtonOf(2)).toBeNull();
  });

  it('closes the form, offers no disarm and no edit when a save of a disarmed trigger could not be confirmed', async () => {
    await renderTriggers({ api: { listTriggers: listAnswering(list(trigger()), unreadable) } });
    await choose(FIRST);
    await userEvent.click(screen.getByRole('button', { name: 'Modifier' }));

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await reloadButton();

    expect(screen.queryByTestId('trigger-editor')).toBeNull();
    expect(pill()).toHaveTextContent('État inconnu — recharger');
    expect(screen.queryByRole('button', { name: 'Désarmer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Modifier' })).toBeNull();
  });

  it('offers to disarm when a save of an armed trigger could not be confirmed', async () => {
    await renderTriggers({ triggers: [armed()], api: { listTriggers: listAnswering(list(armed()), unreadable) } });
    await choose(FIRST);
    await userEvent.click(screen.getByRole('button', { name: 'Modifier' }));

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await reloadButton();

    expect(screen.getByRole('button', { name: 'Désarmer' })).toBeInTheDocument();
  });

  it('disarms from the unknown state and shows the real state afterwards', async () => {
    const { api } = await renderTriggers({ api: { listTriggers: listAnswering(list(trigger()), unreadable, list(trigger())) } });
    await choose(FIRST);
    await arm(2);
    await reloadButton();

    await userEvent.click(screen.getByRole('button', { name: 'Désarmer' }));

    await screen.findByRole('button', { name: 'Armer la révision 2' });
    expect(api.disarmTrigger).toHaveBeenCalledWith('t1');
    expect(pill()).toHaveTextContent('Désarmé');
  });

  describe('when the user has moved on to another trigger', () => {
    async function armFirstLateThenChooseSecond(listAfterwards: Array<() => Promise<TriggerView[]>>) {
      const armAnswer = deferred<TriggerView>();
      const listTriggers = listAnswering(list(trigger(), secondTrigger()), ...listAfterwards);
      const rendered = await renderTriggers({ triggers: [trigger(), secondTrigger()], api: { listTriggers, armTrigger: vi.fn(() => armAnswer.promise) } });
      await choose(FIRST);
      await arm(2);
      await letPendingAnswersLand(rendered.fixture);
      await choose(SECOND);
      armAnswer.resolve(armed());
      await letPendingAnswersLand(rendered.fixture);
      return rendered;
    }

    it('leaves the second trigger as it is and shows the first one unknown when it is chosen again', async () => {
      await armFirstLateThenChooseSecond([unreadable]);

      expect(pill()).toHaveTextContent('Désarmé');
      expect(armButtonOf(5)).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Recharger' })).toBeNull();

      await choose(FIRST);

      expect(pill()).toHaveTextContent('État inconnu — recharger');
    });

    it('forgets the unknown state of the first trigger once another write reads the list again', async () => {
      await armFirstLateThenChooseSecond([unreadable, list(armed(), secondTrigger({ armedAt: '2026-11-05T13:00:00Z', approvedRev: 5, approvedGraphDigest: 'digest-5' }))]);
      await arm(5);
      await screen.findByRole('button', { name: 'Désarmer' });

      await choose(FIRST);

      expect(pill()).toHaveTextContent('Armé');
    });
  });
});
