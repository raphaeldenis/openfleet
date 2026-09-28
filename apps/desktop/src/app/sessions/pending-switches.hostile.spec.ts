import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionMode, SessionState } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { ModelSelectorComponent } from './model-selector.component';
import { PermissionModePickerComponent } from './permission-mode-picker.component';
import { SWITCH_KINDS, applyButtonOf, deferred, errorOf, noteOf, requestSwitch, settleRequests } from '../testing/session-view.testing';

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
      <of-permission-mode-picker [sessionId]="sessionId()" [currentMode]="shown()?.permissionMode" />
    }
  `,
})
class SelectorsHostComponent {
  readonly sessionId = signal('s1');
  readonly visible = signal(true);
  private readonly events = inject(FleetEventsService);
  protected readonly shown = computed(() => this.events.sessions().find((s) => s.id === this.sessionId()));
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

const modelSwitch = SWITCH_KINDS[0];
const permissionModeSwitch = SWITCH_KINDS[1];
const requestModelSwitch = () => requestSwitch(modelSwitch);
const requestPermissionModeSwitch = () => requestSwitch(permissionModeSwitch);
const modelNote = () => noteOf(modelSwitch);
const permissionModeNote = () => noteOf(permissionModeSwitch);

const setStateOf = (sessions: ReturnType<typeof signal<FakeSession[]>>, id: string, state: SessionState) =>
  sessions.update((all) => all.map((s) => (s.id === id ? { ...s, state } : s)));

describe('PendingSwitchesService through the model selector and the permission-mode picker', () => {
  describe('the model entry and the permission-mode entry of one session', () => {
    it('keeps a model switch out of the permission-mode picker', async () => {
      const { goTo } = await renderSelectors();
      await requestModelSwitch();
      await waitFor(() => expect(modelNote()).toBeTruthy());

      await goTo('s2');
      await goTo('s1');

      expect(modelNote()).toHaveTextContent('switch pending');
      expect(permissionModeNote()).toBeNull();
    });

    it('keeps a permission-mode switch out of the model selector', async () => {
      const { goTo } = await renderSelectors();
      await requestPermissionModeSwitch();
      await waitFor(() => expect(permissionModeNote()).toBeTruthy());

      await goTo('s2');
      await goTo('s1');

      expect(permissionModeNote()).toHaveTextContent('switch pending');
      expect(modelNote()).toBeNull();
    });

    it('shows both switches of the same session again after A → B → A, and clears each on its own when the turn ends', async () => {
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

  describe('the session view leaving the screen (no sessionId change)', () => {
    it('shows both pending switches again when the selectors are destroyed and come back', async () => {
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

    it('never lets a switch of A show up on B or C during a fast A → B → C → A walk', async () => {
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
    it.each(SWITCH_KINDS)('shows no "restarting…" note for the $kind switch back on the session', async (kind) => {
      // Arrange — an idle session: the REST reply says "relaunching", the daemon starts ~2 s later, then idle again
      const { fixture, goTo, sessions } = await renderSelectors({
        sessions: [fakeSession('s1', 'idle'), fakeSession('s2', 'idle')],
        api: { [kind.apiMethod]: vi.fn().mockResolvedValue({ status: 'relaunching' }) },
      });
      await requestSwitch(kind);
      await waitFor(() => expect(noteOf(kind)).toHaveTextContent('restarting…'));
      await goTo('s2');

      // Act
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();
      await goTo('s1');

      // Assert
      expect(noteOf(kind)).toBeNull();
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
    describe.each(SWITCH_KINDS)('the $kind switch request of A', (kind) => {
      const { apiMethod } = kind;
      const applyButton = () => applyButtonOf(kind);

      it('keeps Apply disabled after A → B → A until the reply lands, then shows the note and lets Apply send again', async () => {
        const reply = deferred<{ status: 'deferred' }>();
        const { fixture, goTo, api } = await renderSelectors({ api: { [apiMethod]: vi.fn(() => reply.promise) } });
        await requestSwitch(kind);
        await goTo('s2');
        await goTo('s1');
        expect(applyButton()).toBeDisabled();

        reply.resolve({ status: 'deferred' });
        await settleRequests(fixture);

        expect(noteOf(kind)).toHaveTextContent('switch pending');
        expect(applyButton()).toBeEnabled();
        await userEvent.click(applyButton());
        expect(api[apiMethod]).toHaveBeenCalledTimes(2);
      });

      it('shows the error on A when the reply fails after A → B → A, and lets Apply send again', async () => {
        const reply = deferred<{ status: 'deferred' }>();
        const { fixture, goTo } = await renderSelectors({ api: { [apiMethod]: vi.fn(() => reply.promise) } });
        await requestSwitch(kind);
        await goTo('s2');
        await goTo('s1');

        reply.reject(new Error('boom'));
        await settleRequests(fixture);

        expect(errorOf(kind)).toHaveTextContent(/could not/i);
        expect(noteOf(kind)).toBeNull();
        expect(applyButton()).toBeEnabled();
      });

      it.each([
        { outcome: 'resolves', settle: (reply: ReturnType<typeof deferred<{ status: 'deferred' }>>) => reply.resolve({ status: 'deferred' }) },
        { outcome: 'rejects', settle: (reply: ReturnType<typeof deferred<{ status: 'deferred' }>>) => reply.reject(new Error('boom')) },
      ])('keeps B\'s own pending request busy when A\'s request $outcome', async ({ settle }) => {
        const replyOfA = deferred<{ status: 'deferred' }>();
        const replyOfB = deferred<{ status: 'deferred' }>();
        const answerBySession = (sessionId: string) => (sessionId === 's1' ? replyOfA.promise : replyOfB.promise);
        const { fixture, goTo } = await renderSelectors({ api: { [apiMethod]: vi.fn(answerBySession) } });
        await requestSwitch(kind);
        await goTo('s2');
        await requestSwitch(kind);

        settle(replyOfA);
        await settleRequests(fixture);

        expect(applyButton()).toBeDisabled();
        expect(errorOf(kind)).toBeNull();
        replyOfB.resolve({ status: 'deferred' });
      });
    });
  });

  describe('a relaunch whose daemon events outrun the switch reply', () => {
    it.each(SWITCH_KINDS)('shows no "restarting…" note for the $kind switch when the relaunch has already finished by the time the reply lands', async (kind) => {
      const { apiMethod } = kind;
      // Arrange — an idle session: the daemon starts the relaunch and finishes it before the HTTP reply reaches the UI
      const reply = deferred<{ status: 'relaunching' }>();
      const { fixture, sessions } = await renderSelectors({
        sessions: [fakeSession('s1', 'idle'), fakeSession('s2', 'idle')],
        api: { [apiMethod]: vi.fn(() => reply.promise) },
      });
      await requestSwitch(kind);
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();

      // Act
      reply.resolve({ status: 'relaunching' });
      await settleRequests(fixture);

      // Assert
      expect(noteOf(kind)).toBeNull();
    });

    it.each(SWITCH_KINDS)('shows "restarting…" for the $kind switch when the relaunch has started but not finished by the time the reply lands, and clears it at idle', async (kind) => {
      const { apiMethod } = kind;
      const reply = deferred<{ status: 'relaunching' }>();
      const { fixture, sessions } = await renderSelectors({
        sessions: [fakeSession('s1', 'idle'), fakeSession('s2', 'idle')],
        api: { [apiMethod]: vi.fn(() => reply.promise) },
      });
      await requestSwitch(kind);
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();

      reply.resolve({ status: 'relaunching' });
      await settleRequests(fixture);
      expect(noteOf(kind)).toHaveTextContent('restarting…');

      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();
      expect(noteOf(kind)).toBeNull();
    });

    it.each(SWITCH_KINDS)('keeps no note for the $kind switch when the turn ends before the "deferred" reply lands', async (kind) => {
      const { apiMethod } = kind;
      const reply = deferred<{ status: 'deferred' }>();
      const { fixture, sessions } = await renderSelectors({ api: { [apiMethod]: vi.fn(() => reply.promise) } });
      await requestSwitch(kind);
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();

      reply.resolve({ status: 'deferred' });
      await settleRequests(fixture);

      expect(noteOf(kind)).toBeNull();
    });

    it.each(SWITCH_KINDS)('shows the right $kind note on return when the relaunch ran while the user was away', async (kind) => {
      const { apiMethod } = kind;
      const reply = deferred<{ status: 'relaunching' }>();
      const { fixture, goTo, sessions } = await renderSelectors({
        sessions: [fakeSession('s1', 'idle'), fakeSession('s2', 'idle')],
        api: { [apiMethod]: vi.fn(() => reply.promise) },
      });
      await requestSwitch(kind);
      await goTo('s2');
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();
      reply.resolve({ status: 'relaunching' });
      await settleRequests(fixture);
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();

      await goTo('s1');

      expect(noteOf(kind)).toBeNull();
    });
  });

  describe('a second switch requested while the first relaunch is still starting', () => {
    it.each(SWITCH_KINDS)('keeps the "restarting…" note of the second $kind relaunch through the idle that ends the first one', async (kind) => {
      const { apiMethod } = kind;
      // Arrange — the first relaunch is under way (starting) when the user applies again
      const { fixture, sessions } = await renderSelectors({
        sessions: [fakeSession('s1', 'idle'), fakeSession('s2', 'idle')],
        api: { [apiMethod]: vi.fn().mockResolvedValue({ status: 'relaunching' }) },
      });
      await requestSwitch(kind);
      await waitFor(() => expect(noteOf(kind)).toHaveTextContent('restarting…'));
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();
      await userEvent.click(applyButtonOf(kind));
      await settleRequests(fixture);

      // Act — the first relaunch is done
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();

      // Assert — the second relaunch has not run yet
      expect(noteOf(kind)).toHaveTextContent('restarting…');
      setStateOf(sessions, 's1', 'starting');
      await fixture.whenStable();
      setStateOf(sessions, 's1', 'idle');
      await fixture.whenStable();
      expect(noteOf(kind)).toBeNull();
    });
  });
});
