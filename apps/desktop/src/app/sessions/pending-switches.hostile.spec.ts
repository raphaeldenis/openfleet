import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionMode, SessionState } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { PendingSwitchesService } from '../core/pending-switches.service';
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
  const pendingSwitches = fixture.debugElement.injector.get(PendingSwitchesService);
  const goTo = async (id: string) => {
    host.sessionId.set(id);
    await fixture.whenStable();
  };
  return { fixture, host, sessions, api, pendingSwitches, goTo };
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
      const { goTo, sessions, pendingSwitches } = await renderSelectors();
      await requestModelSwitch();
      await requestPermissionModeSwitch();
      await waitFor(() => expect(permissionModeNote()).toBeTruthy());

      await goTo('s2');
      expect(pendingSwitches.recall('s1', 'model')?.requestedValue).toBe('opus');
      expect(pendingSwitches.recall('s1', 'permissionMode')?.requestedValue).toBe('acceptEdits');
      await goTo('s1');
      expect(modelNote()).toBeTruthy();
      expect(permissionModeNote()).toBeTruthy();

      sessions.update((all) => all.map((s) => (s.id === 's1' ? { ...s, state: 'idle' as const } : s)));

      await waitFor(() => expect(modelNote()).toBeNull());
      await waitFor(() => expect(permissionModeNote()).toBeNull());
    });
  });

  describe('parking on destroy (the session view leaves the screen, no sessionId change)', () => {
    it('parks both pending switches when the selectors are destroyed, and restores them when they come back', async () => {
      const { fixture, host, pendingSwitches } = await renderSelectors();
      await requestModelSwitch();
      await requestPermissionModeSwitch();
      await waitFor(() => expect(permissionModeNote()).toBeTruthy());

      host.visible.set(false);
      await fixture.whenStable();
      expect(modelNote()).toBeNull();
      expect(pendingSwitches.recall('s1', 'model')?.status).toBe('deferred');
      expect(pendingSwitches.recall('s1', 'permissionMode')?.status).toBe('deferred');

      host.visible.set(true);
      await fixture.whenStable();

      expect(modelNote()).toHaveTextContent('switch pending');
      expect(permissionModeNote()).toHaveTextContent('switch pending');
      expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('opus');
      expect((screen.getByTestId('permission-mode-select') as HTMLSelectElement).value).toBe('acceptEdits');
    });

    it('parks nothing when the selectors are destroyed with no switch pending', async () => {
      const { fixture, host, pendingSwitches } = await renderSelectors();

      host.visible.set(false);
      await fixture.whenStable();

      expect(pendingSwitches.recall('s1', 'model')).toBeUndefined();
      expect(pendingSwitches.recall('s1', 'permissionMode')).toBeUndefined();
    });

    it('does not resurrect a switch that settled, after coming back to its session, before the selectors were destroyed', async () => {
      const { fixture, host, goTo, sessions, pendingSwitches } = await renderSelectors();
      await requestModelSwitch();
      await waitFor(() => expect(modelNote()).toBeTruthy());
      await goTo('s2');
      await goTo('s1');
      expect(pendingSwitches.recall('s1', 'model')?.status).toBe('deferred');
      sessions.update((all) => all.map((s) => (s.id === 's1' ? { ...s, state: 'idle' as const } : s)));
      await waitFor(() => expect(modelNote()).toBeNull());

      host.visible.set(false);
      await fixture.whenStable();

      expect(pendingSwitches.recall('s1', 'model')).toBeUndefined();
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

    it('does not park a switch that was requested on B under A\'s id', async () => {
      const { goTo, pendingSwitches } = await renderSelectors();
      await goTo('s2');
      await requestModelSwitch();
      await waitFor(() => expect(modelNote()).toBeTruthy());

      await goTo('s1');

      expect(pendingSwitches.recall('s1', 'model')).toBeUndefined();
      expect(pendingSwitches.recall('s2', 'model')?.requestedValue).toBe('opus');
      expect(modelNote()).toBeNull();
    });
  });

  describe('a relaunch that runs from start to finish while the user is elsewhere', () => {
    const setStateOf = (sessions: ReturnType<typeof signal<FakeSession[]>>, id: string, state: SessionState) =>
      sessions.update((all) => all.map((s) => (s.id === id ? { ...s, state } : s)));

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
    it('forgets the parked switch of a session that disappeared from the fleet', async () => {
      const { fixture, goTo, sessions, pendingSwitches } = await renderSelectors();
      await requestModelSwitch();
      await waitFor(() => expect(modelNote()).toBeTruthy());
      await goTo('s2');

      sessions.update((all) => all.filter((s) => s.id !== 's1'));
      await fixture.whenStable();

      expect(pendingSwitches.recall('s1', 'model')).toBeUndefined();
    });

    it('forgets the parked switches of a session that closed while the user was elsewhere', async () => {
      const { fixture, goTo, sessions, pendingSwitches } = await renderSelectors();
      await requestModelSwitch();
      await requestPermissionModeSwitch();
      await waitFor(() => expect(permissionModeNote()).toBeTruthy());
      await goTo('s2');

      sessions.update((all) => all.map((s) => (s.id === 's1' ? { ...s, state: 'closed' as const } : s)));
      await fixture.whenStable();

      expect(pendingSwitches.recall('s1', 'model')).toBeUndefined();
      expect(pendingSwitches.recall('s1', 'permissionMode')).toBeUndefined();
    });

    it('keeps the parked switches of a session that is still open while another session closes', async () => {
      const { fixture, goTo, sessions, pendingSwitches } = await renderSelectors();
      await requestModelSwitch();
      await waitFor(() => expect(modelNote()).toBeTruthy());
      await goTo('s2');

      sessions.update((all) => all.map((s) => (s.id === 's2' ? { ...s, state: 'closed' as const } : s)));
      await fixture.whenStable();

      expect(pendingSwitches.recall('s1', 'model')?.status).toBe('deferred');
    });
  });

  describe('a switch reply or a request that outlives the session view', () => {
    // P2-U2e
    it.fails('parks a model switch whose reply arrives after the user left the session', async () => {
      const reply = deferred<{ status: 'deferred' }>();
      const { fixture, goTo } = await renderSelectors({ api: { updateModel: vi.fn(() => reply.promise) } });
      await requestModelSwitch();
      await goTo('s2');
      reply.resolve({ status: 'deferred' });
      await fixture.whenStable();

      await goTo('s1');

      expect(modelNote()).toHaveTextContent('switch pending');
    });

    // P2-U2e
    it.fails('parks a permission-mode switch whose reply arrives after the user left the session', async () => {
      const reply = deferred<{ status: 'deferred' }>();
      const { fixture, goTo } = await renderSelectors({ api: { updatePermissionMode: vi.fn(() => reply.promise) } });
      await requestPermissionModeSwitch();
      await goTo('s2');
      reply.resolve({ status: 'deferred' });
      await fixture.whenStable();

      await goTo('s1');

      expect(permissionModeNote()).toHaveTextContent('switch pending');
    });

    // P2-U2e
    it.fails('does not send a second model switch for A while its first request is still in flight after A → B → A', async () => {
      const reply = deferred<{ status: 'deferred' }>();
      const { goTo, api } = await renderSelectors({ api: { updateModel: vi.fn(() => reply.promise) } });
      await requestModelSwitch();
      await goTo('s2');
      await goTo('s1');

      await userEvent.click(screen.getByTestId('apply-model'));

      expect(api.updateModel).toHaveBeenCalledTimes(1);
      reply.resolve({ status: 'deferred' });
    });
  });
});
