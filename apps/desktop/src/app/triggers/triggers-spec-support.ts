import type { ComponentFixture } from '@angular/core/testing';
import { MANAGER_ROLE, type Project, type Session, type TriggerFireView } from '@openfleet/shared';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { OperatorNonceMinter } from '../core/operator-nonce-minter';
import type { TriggerView } from '../core/playbook-trigger-views';
import { TriggersViewComponent } from './triggers-view.component';

export const PROJECT = { id: 'p1', name: 'Alpha' } as Project;
export const FIRST = 'Réveiller Capitaine';

export const trigger = (overrides: Partial<TriggerView> = {}): TriggerView => ({
  id: 't1', projectId: 'p1', ownerManagerId: 'm1', title: FIRST, when: { source: 'session_state', state: 'idle', minutes: 10 }, conditions: [],
  run: { kind: 'notify', title: 'Inactive', message: 'Une session dort.' }, policy: { cooldownSeconds: 0, batchMode: 'per_event', backlogPolicy: 'fire_all', backlogMaxAgeMinutes: 45 },
  contentRev: 2, armedAt: null, approvedRev: null, approvedGraphDigest: null, reviewDigest: 'digest-2', updatedAt: '2026-11-05T10:00:00Z', ...overrides,
});
export const armed = (overrides: Partial<TriggerView> = {}) => trigger({ armedAt: '2026-11-05T12:00:00Z', approvedRev: 2, approvedGraphDigest: 'digest-2', ...overrides });

/** A session as the daemon lists it; only what the owner choice reads is set. */
export const sessionOf = ({ id, name, role, projectId = 'p1' }: { id: string; name: string; role?: string; projectId?: string }) => ({ id, name, role, projectId }) as Session;
export const managerOf = (id: string, name: string, projectId = 'p1') => sessionOf({ id, name, role: MANAGER_ROLE, projectId });

export type FakeApi = Partial<Record<keyof FleetApiService, ReturnType<typeof vi.fn>>>;

/** An answer the test settles itself, in the order it wants. */
export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

/** Barrier: a zero-delay macrotask runs after every queued microtask, so each pending answer has been consumed; then Angular renders. */
export async function letPendingAnswersLand(fixture: ComponentFixture<unknown>): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await fixture.whenStable();
}

export async function renderTriggers({ api: overrides = {}, triggers = [trigger()], sessions = [managerOf('m1', 'Capitaine')] }: { api?: FakeApi; triggers?: TriggerView[]; sessions?: Session[] } = {}) {
  const api = {
    listProjects: vi.fn(() => Promise.resolve({ items: [PROJECT], total: 1, limit: 200, offset: 0 })),
    listPlaybooks: vi.fn(() => Promise.resolve([])),
    listTriggers: vi.fn(() => Promise.resolve(triggers)),
    listTriggerFires: vi.fn(() => Promise.resolve([] as TriggerFireView[])),
    listSessions: vi.fn(() => Promise.resolve(sessions)),
    getTrigger: vi.fn((id: string) => Promise.resolve(triggers.find((candidate) => candidate.id === id)!)),
    armTrigger: vi.fn(() => Promise.resolve(armed())),
    disarmTrigger: vi.fn(() => Promise.resolve(trigger())),
    updateTrigger: vi.fn(() => Promise.resolve(trigger())),
    ...overrides,
  };
  const minter = { mintTriggerArmingNonce: vi.fn(() => Promise.resolve('nonce-1')) };
  const { fixture } = await render(TriggersViewComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: OperatorNonceMinter, useValue: minter }] });
  await userEvent.click(screen.getByRole('tab', { name: 'Triggers' }));
  return { api, fixture };
}

export const choose = async (title: string) => userEvent.click(await screen.findByRole('button', { name: new RegExp(title) }));
export const openEditor = async () => userEvent.click(await screen.findByRole('button', { name: 'Modifier' }));
export const save = () => userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
