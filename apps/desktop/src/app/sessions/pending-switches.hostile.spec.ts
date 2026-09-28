import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionMode, SessionState } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { ModelSelectorComponent } from './model-selector.component';
import { PermissionModePickerComponent } from './permission-mode-picker.component';

interface FakeSession { id: string; name: string; emoji: string; model: string; state: SessionState; permissionMode: PermissionMode }

function fakeSession(id: string, state: SessionState = 'generating'): FakeSession {
  return { id, name: id, emoji: '⚔️', model: 'claude-sonnet-5', state, permissionMode: 'manual' };
}

/** Mounts the two selectors the way the session header does, so navigation is a `sessionId` change or a destroy/recreate. */
@Component({
  selector: 'of-selectors-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ModelSelectorComponent, PermissionModePickerComponent],
  template: `
    @if (visible()) {
      <of-model-selector [sessionId]="sessionId()" />
      <of-permission-mode-picker [sessionId]="sessionId()" [currentMode]="shown()?.permissionMode" [sessionState]="shown()?.state" />
    }
  `,
})
class SelectorsHostComponent {
  readonly sessionId = signal('s1');
  readonly visible = signal(true);
  private readonly events = inject(FleetEventsService);
  protected readonly shown = computed(() => this.events.sessions().find((s) => s.id === this.sessionId()));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function renderSelectors(options: { sessions?: FakeSession[]; api?: Partial<Record<'updateModel' | 'updatePermissionMode', ReturnType<typeof vi.fn>>> } = {}) {
  const sessions = signal<FakeSession[]>(options.sessions ?? [fakeSession('s1'), fakeSession('s2', 'idle')]);
  const api = {
    updateModel: vi.fn().mockResolvedValue({ status: 'deferred' }),
    updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }),
    ...options.api,
  };
  const { fixture } = await render(SelectorsHostComponent, {
    providers: [
      { provide: FleetApiService, useValue: api },
      { provide: FleetEventsService, useValue: { sessions, approvals: signal([]), managers: signal([]) } },
    ],
  });
  const host = fixture.componentInstance;
  const goTo = async (id: string) => {
    host.sessionId.set(id);
    await fixture.whenStable();
  };
  return { fixture, host, sessions, api, goTo };
}

async function requestModelSwitch() {
  await userEvent.selectOptions(screen.getByTestId('model-select'), 'opus');
  await userEvent.click(screen.getByTestId('apply-model'));
}

async function requestPermissionModeSwitch() {
  await userEvent.selectOptions(screen.getByTestId('permission-mode-select'), 'acceptEdits');
  await userEvent.click(screen.getByTestId('apply-permission-mode'));
}

const modelNote = () => screen.queryByTestId('model-switch-status');
const permissionModeNote = () => screen.queryByTestId('permission-mode-switch-status');
const modelError = () => screen.queryByTestId('model-switch-error');
const permissionModeError = () => screen.queryByTestId('permission-mode-switch-error');

const PROMISE_HOPS_OF_A_SETTLED_REQUEST = 10;

/** Runs the continuations chained on a settled request (action → runGuarded → caller), then renders. */
async function settleRequests(fixture: { whenStable(): Promise<unknown> }) {
  for (let hop = 0; hop < PROMISE_HOPS_OF_A_SETTLED_REQUEST; hop++) await Promise.resolve();
  await fixture.whenStable();
}

const setStateOf = (sessions: ReturnType<typeof signal<FakeSession[]>>, id: string, state: SessionState) =>
  sessions.update((all) => all.map((s) => (s.id === id ? { ...s, state } : s)));

const SWITCH_KINDS = [
  { kind: 'model', request: requestModelSwitch, note: modelNote, error: modelError, apiMethod: 'updateModel', applyTestId: 'apply-model' },
  { kind: 'permission-mode', request: requestPermissionModeSwitch, note: permissionModeNote, error: permissionModeError, apiMethod: 'updatePermissionMode', applyTestId: 'apply-permission-mode' },
] as const;

describe('PendingSwitchesService through the model selector and the permission-mode picker', () => {
  describe('the model entry and the permission-mode entry of one session', () => {
    it('keeps a parked model switch out of the permission-mode picker', async () => {
      const { goTo } = await renderSelectors();
      await requestModelSwitch();
      await waitFor(() => expect(modelNote()).toBeTruthy());

      await goTo('s2');
      await goTo('s1');

      expect(modelNote()).toHaveTextContent('switch pending');
      expect(permissionModeNote()).toBeNull();
    });

    it('keeps a parked permission-mode switch out of the model selector', async () => {
      const { goTo } = await renderSelectors();
      await requestPermissionModeSwitch();
      await waitFor(() => expect(permissionModeNote()).toBeTruthy());

      await goTo('s2');
      await goTo('s1');

      expect(permissionModeNote()).toHaveTextContent('switch pending');
      expect(modelNote()).toBeNull();
    });

    it('parks both switches of the same session, restores both, and clears each on its own when the turn ends', async () => {
      const { goTo, sessions } = await renderSelectors();
      await requestModelSwitch();
      await requestPermissionModeSwitch();
      await waitFor(() => expect(permissionModeNote()).toBeTruthy());

      await goTo('s2');
      await goTo('s1');
      expect(modelNote()).toBeTruthy();
      expect(permissionModeNote()).toBeTruthy();
      expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('opus');
      expect((screen.getByTestId('permission-mode-select') as HTMLSelectElement).value).toBe('acceptEdits');

      sessions.update((all) => all.map((s) => (s.id === 's1' ? { ...s, state: 'idle' as const } : s)));

      await waitFor(() => expect(modelNote()).toBeNull());
      await waitFor(() => expect(permissionModeNote()).toBeNull());
    });
  });

  describe('parking on destroy (the session view leaves the screen, no sessionId change)', () => {
    it('parks both pending switches when the selectors are destroyed, and restores them when they come back', async () => {
      const { fixture, host } = await renderSelectors();
      await requestModelSwitch();
      await requestPermissionModeSwitch();
      await waitFor(() => expect(permissionModeNote()).toBeTruthy());

      host.visible.set(false);
      await fixture.whenStable();
      expect(modelNote()).toBeNull();

      host.visible.set(true);
      await fixture.whenStable();

      expect(modelNote()).toHaveTextContent('switch pending');
      expect(permissionModeNote()).toHaveTextContent('switch pending');
      expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('opus');
      expect((screen.getByTestId('permission-mode-select') as HTMLSelectElement).value).toBe('acceptEdits');
    });

    it('shows no note on return when the selectors were destroyed with no switch pending', async () => {
      const { fixture, host } = await renderSelectors();

      host.visible.set(false);
      await fixture.whenStable();
      host.visible.set(true);
      await fixture.whenStable();

      expect(modelNote()).toBeNull();
      expect(permissionModeNote()).toBeNull();
    });

    it('does not resurrect a switch that settled, after coming back to its session, before the selectors were destroyed', async () => {
      const { fixture, host, goTo, sessions } = await renderSelectors();
      await requestModelSwitch();
      await waitFor(() => expect(modelNote()).toBeTruthy());
      await goTo('s2');
      await goTo('s1');
      sessions.update((all) => all.map((s) => (s.id === 's1' ? { ...s, state: 'idle' as const } : s)));
      await waitFor(() => expect(modelNote()).toBeNull());

      host.visible.set(false);
      await fixture.whenStable();
      host.visible.set(true);
      await fixture.whenStable();

      expect(modelNote()).toBeNull();
    });
  });

  describe('switching A → B → A quickly', () => {
    it('keeps the note when the hops A → B → A land in one change-detection pass', async () => {
      const { host, fixture } = await renderSelectors();
      await requestModelSwitch();
      await waitFor(() => expect(modelNote()).toBeTruthy());

      host.sessionId.set('s2');
      host.sessionId.set('s1');
      await fixture.whenStable();

      expect(modelNote()).toHaveTextContent('switch pending');
      expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('opus');
    });

    it('never lets a switch parked for A show up on B or C during a fast A → B → C → A walk', async () => {
      const { goTo } = await renderSelectors({ sessions: [fakeSession('s1'), fakeSession('s2', 'idle'), fakeSession('s3', 'idle')] });
      await requestModelSwitch();
      await requestPermissionModeSwitch();
      await waitFor(() => expect(permissionModeNote()).toBeTruthy());

      await goTo('s2');
      expect(modelNote()).toBeNull();
      expect(permissionModeNote()).toBeNull();
      await goTo('s3');
      expect(modelNote()).toBeNull();
      expect(permissionModeNote()).toBeNull();
      await goTo('s1');

      expect(modelNote()).toBeTruthy();
      expect(permissionModeNote()).toBeTruthy();
    });

    it('does not show a switch that was requested on B on A, and gives it back on B', async () => {
      const { goTo } = await renderSelectors();
      await goTo('s2');
      await requestModelSwitch();
      await waitFor(() => expect(modelNote()).toBeTruthy());

      await goTo('s1');
      expect(modelNote()).toBeNull();
      expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('claude-sonnet-5');

      await goTo('s2');
      expect(modelNote()).toHaveTextContent('switch pending');
      expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('opus');
    });
  });

  describe('a relaunch that runs from start to finish while the user is elsewhere', () => {
    it.each([
      { kind: 'model', request: requestModelSwitch, note: modelNote, apiMethod: 'updateModel' },
      { kind: 'permission-mode', request: requestPermissionModeSwitch, note: permissionModeNote, apiMethod: 'updatePermissionMode' },
    ])('shows no "restarting…" note for the $kind switch back on the session', async ({ request, note, apiMethod }) => {
      // Arrange — an idle session: the REST reply says "relaunching", the daemon starts ~2 s later, then idle again
      const { fixture, goTo, sessions } = await renderSelectors({
        sessions: [fakeSession('s1', 'idle'), fakeSession('s2', 'idle')],
        api: { [apiMethod]: vi.fn().mockResolvedValue({ status: 'relaunching' }) },
      });
      await request();
      await waitFor(() => expect(note()).toHaveTextContent('restarting…'));
      await goTo('s2');

      // Act
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();
      await goTo('s1');

      // Assert
      expect(note()).toBeNull();
    });

    it('still shows "restarting…" when the user is back before the relaunch has even started', async () => {
      const { goTo } = await renderSelectors({
        sessions: [fakeSession('s1', 'idle'), fakeSession('s2', 'idle')],
        api: { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) },
      });
      await requestModelSwitch();
      await waitFor(() => expect(modelNote()).toHaveTextContent('restarting…'));

      await goTo('s2');
      await goTo('s1');

      expect(modelNote()).toHaveTextContent('restarting…');
    });
  });

  describe('a session that leaves the fleet', () => {
    it('shows no old note when a session that closed while the user was elsewhere is resumed', async () => {
      const { fixture, goTo, sessions } = await renderSelectors();
      await requestModelSwitch();
      await requestPermissionModeSwitch();
      await waitFor(() => expect(permissionModeNote()).toBeTruthy());
      await goTo('s2');

      setStateOf(sessions, 's1', 'closed');
      await fixture.whenStable();
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();
      await goTo('s1');

      expect(modelNote()).toBeNull();
      expect(permissionModeNote()).toBeNull();
    });

    it('keeps the note of a session that is still open while another session closes', async () => {
      const { fixture, goTo, sessions } = await renderSelectors();
      await requestModelSwitch();
      await waitFor(() => expect(modelNote()).toBeTruthy());
      await goTo('s2');

      setStateOf(sessions, 's2', 'closed');
      await fixture.whenStable();
      await goTo('s1');

      expect(modelNote()).toHaveTextContent('switch pending');
    });
  });

  describe('a switch reply or a request that outlives the session view', () => {
    it('parks a model switch whose reply arrives after the user left the session', async () => {
      const reply = deferred<{ status: 'deferred' }>();
      const { fixture, goTo } = await renderSelectors({ api: { updateModel: vi.fn(() => reply.promise) } });
      await requestModelSwitch();
      await goTo('s2');
      reply.resolve({ status: 'deferred' });
      await fixture.whenStable();

      await goTo('s1');

      expect(modelNote()).toHaveTextContent('switch pending');
    });

    it('parks a permission-mode switch whose reply arrives after the user left the session', async () => {
      const reply = deferred<{ status: 'deferred' }>();
      const { fixture, goTo } = await renderSelectors({ api: { updatePermissionMode: vi.fn(() => reply.promise) } });
      await requestPermissionModeSwitch();
      await goTo('s2');
      reply.resolve({ status: 'deferred' });
      await fixture.whenStable();

      await goTo('s1');

      expect(permissionModeNote()).toHaveTextContent('switch pending');
    });

    describe.each(SWITCH_KINDS)('the $kind switch request of A', ({ request, note, error, apiMethod, applyTestId }) => {
      const applyButton = () => screen.getByTestId(applyTestId);

      it('is not sent a second time while the first is still in flight after A → B → A', async () => {
        const reply = deferred<{ status: 'deferred' }>();
        const { goTo, api } = await renderSelectors({ api: { [apiMethod]: vi.fn(() => reply.promise) } });
        await request();
        await goTo('s2');
        await goTo('s1');

        await userEvent.click(applyButton());

        expect(api[apiMethod]).toHaveBeenCalledTimes(1);
        reply.resolve({ status: 'deferred' });
      });

      it('keeps Apply disabled after A → B → A until the reply lands, then shows the note and lets Apply send again', async () => {
        const reply = deferred<{ status: 'deferred' }>();
        const { fixture, goTo, api } = await renderSelectors({ api: { [apiMethod]: vi.fn(() => reply.promise) } });
        await request();
        await goTo('s2');
        await goTo('s1');
        expect(applyButton()).toBeDisabled();

        reply.resolve({ status: 'deferred' });
        await settleRequests(fixture);

        expect(note()).toHaveTextContent('switch pending');
        expect(applyButton()).toBeEnabled();
        await userEvent.click(applyButton());
        expect(api[apiMethod]).toHaveBeenCalledTimes(2);
      });

      it('shows the error on A when the reply fails after A → B → A, and lets Apply send again', async () => {
        const reply = deferred<{ status: 'deferred' }>();
        const { fixture, goTo } = await renderSelectors({ api: { [apiMethod]: vi.fn(() => reply.promise) } });
        await request();
        await goTo('s2');
        await goTo('s1');

        reply.reject(new Error('boom'));
        await settleRequests(fixture);

        expect(error()).toHaveTextContent(/could not/i);
        expect(note()).toBeNull();
        expect(applyButton()).toBeEnabled();
      });

      it.each([
        { outcome: 'resolves', settle: (reply: ReturnType<typeof deferred<{ status: 'deferred' }>>) => reply.resolve({ status: 'deferred' }) },
        { outcome: 'rejects', settle: (reply: ReturnType<typeof deferred<{ status: 'deferred' }>>) => reply.reject(new Error('boom')) },
      ])('leaves B untouched when A\'s request $outcome while B is shown', async ({ settle }) => {
        const reply = deferred<{ status: 'deferred' }>();
        const { fixture, goTo } = await renderSelectors({ api: { [apiMethod]: vi.fn(() => reply.promise) } });
        await request();
        await goTo('s2');

        settle(reply);
        await settleRequests(fixture);

        expect(applyButton()).toBeEnabled();
        expect(note()).toBeNull();
        expect(error()).toBeNull();
      });

      it.each([
        { outcome: 'resolves', settle: (reply: ReturnType<typeof deferred<{ status: 'deferred' }>>) => reply.resolve({ status: 'deferred' }) },
        { outcome: 'rejects', settle: (reply: ReturnType<typeof deferred<{ status: 'deferred' }>>) => reply.reject(new Error('boom')) },
      ])('keeps B\'s own pending request busy when A\'s request $outcome', async ({ settle }) => {
        const replyOfA = deferred<{ status: 'deferred' }>();
        const replyOfB = deferred<{ status: 'deferred' }>();
        const answerBySession = (sessionId: string) => (sessionId === 's1' ? replyOfA.promise : replyOfB.promise);
        const { fixture, goTo } = await renderSelectors({ api: { [apiMethod]: vi.fn(answerBySession) } });
        await request();
        await goTo('s2');
        await request();

        settle(replyOfA);
        await settleRequests(fixture);

        expect(applyButton()).toBeDisabled();
        expect(error()).toBeNull();
        replyOfB.resolve({ status: 'deferred' });
      });
    });
  });

  describe('a relaunch whose daemon events outrun the switch reply', () => {
    it.each(SWITCH_KINDS)('shows no "restarting…" note for the $kind switch when the relaunch has already finished by the time the reply lands', async ({ request, note, apiMethod }) => {
      // Arrange — an idle session: the daemon starts the relaunch and finishes it before the HTTP reply reaches the UI
      const reply = deferred<{ status: 'relaunching' }>();
      const { fixture, sessions } = await renderSelectors({
        sessions: [fakeSession('s1', 'idle'), fakeSession('s2', 'idle')],
        api: { [apiMethod]: vi.fn(() => reply.promise) },
      });
      await request();
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();

      // Act
      reply.resolve({ status: 'relaunching' });
      await settleRequests(fixture);

      // Assert
      expect(note()).toBeNull();
    });

    it.each(SWITCH_KINDS)('shows "restarting…" for the $kind switch when the relaunch has started but not finished by the time the reply lands, and clears it at idle', async ({ request, note, apiMethod }) => {
      const reply = deferred<{ status: 'relaunching' }>();
      const { fixture, sessions } = await renderSelectors({
        sessions: [fakeSession('s1', 'idle'), fakeSession('s2', 'idle')],
        api: { [apiMethod]: vi.fn(() => reply.promise) },
      });
      await request();
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();

      reply.resolve({ status: 'relaunching' });
      await settleRequests(fixture);
      expect(note()).toHaveTextContent('restarting…');

      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();
      expect(note()).toBeNull();
    });

    it.each(SWITCH_KINDS)('keeps no note for the $kind switch when the turn ends before the "deferred" reply lands', async ({ request, note, apiMethod }) => {
      const reply = deferred<{ status: 'deferred' }>();
      const { fixture, sessions } = await renderSelectors({ api: { [apiMethod]: vi.fn(() => reply.promise) } });
      await request();
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();

      reply.resolve({ status: 'deferred' });
      await settleRequests(fixture);

      expect(note()).toBeNull();
    });

    it.each(SWITCH_KINDS)('parks the $kind switch of a user who left, so the note is right when the relaunch ran while away', async ({ request, note, apiMethod }) => {
      const reply = deferred<{ status: 'relaunching' }>();
      const { fixture, goTo, sessions } = await renderSelectors({
        sessions: [fakeSession('s1', 'idle'), fakeSession('s2', 'idle')],
        api: { [apiMethod]: vi.fn(() => reply.promise) },
      });
      await request();
      await goTo('s2');
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();
      reply.resolve({ status: 'relaunching' });
      await settleRequests(fixture);
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();

      await goTo('s1');

      expect(note()).toBeNull();
    });
  });

  describe('a second switch requested while the first relaunch is still starting', () => {
    it.each(SWITCH_KINDS)('keeps the "restarting…" note of the second $kind relaunch through the idle that ends the first one', async ({ request, note, apiMethod, applyTestId }) => {
      // Arrange — the first relaunch is under way (starting) when the user applies again
      const { fixture, sessions } = await renderSelectors({
        sessions: [fakeSession('s1', 'idle'), fakeSession('s2', 'idle')],
        api: { [apiMethod]: vi.fn().mockResolvedValue({ status: 'relaunching' }) },
      });
      await request();
      await waitFor(() => expect(note()).toHaveTextContent('restarting…'));
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();
      await userEvent.click(screen.getByTestId(applyTestId));
      await settleRequests(fixture);

      // Act — the first relaunch is done
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();

      // Assert — the second relaunch has not run yet
      expect(note()).toHaveTextContent('restarting…');
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();
      expect(note()).toBeNull();
    });
  });
});
