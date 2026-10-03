import { InjectionToken, signal, type Signal, type WritableSignal } from '@angular/core';
import type { SessionState } from '@openfleet/shared';
import type { SessionTodos, TodoCounts } from './todos.adapter';

export type TodosLoad =
  | { kind: 'loading' }
  | { kind: 'error'; text: string; retryable: boolean }
  | { kind: 'unsupported' }
  | { kind: 'ready'; todos: SessionTodos | null };

/** A direct child of a manager and how far its todo list is; `counts` is null when the child has no list. */
export interface ChildProgress {
  readonly id: string;
  readonly name: string;
  readonly emoji: string;
  readonly state: SessionState;
  readonly isManager: boolean;
  readonly counts: TodoCounts | null;
}

export type ChildrenLoad = { kind: 'unsupported' } | { kind: 'ready'; children: readonly ChildProgress[] };

/** Port: what the Todos tab reads. The REST + WebSocket adapter implements it. */
export interface SessionTodosSource {
  loadOf(sessionId: string): Signal<TodosLoad>;
  /** The direct children of a manager with their todo counts, from the summaries the daemon pushes. */
  childrenOf(managerId: string): Signal<ChildrenLoad>;
  /** Names the one session worth keeping fresh; `undefined` when none is shown. */
  watch(sessionId: string | undefined): void;
  retry(sessionId: string): void;
}

/** In-memory source for tests; an unknown session reads as "no list yet". */
export class InMemorySessionTodosSource implements SessionTodosSource {
  readonly retried: string[] = [];
  readonly watched: (string | undefined)[] = [];
  private readonly loads = new Map<string, WritableSignal<TodosLoad>>();
  private readonly childrenLoads = new Map<string, WritableSignal<ChildrenLoad>>();

  loadOf(sessionId: string): Signal<TodosLoad> {
    return this.signalOf(sessionId);
  }

  childrenOf(managerId: string): Signal<ChildrenLoad> {
    return this.childrenSignalOf(managerId);
  }

  publishChildren(managerId: string, load: ChildrenLoad): void {
    this.childrenSignalOf(managerId).set(load);
  }

  private childrenSignalOf(managerId: string): WritableSignal<ChildrenLoad> {
    const existing = this.childrenLoads.get(managerId);
    if (existing) return existing;
    const created = signal<ChildrenLoad>({ kind: 'ready', children: [] });
    this.childrenLoads.set(managerId, created);
    return created;
  }

  watch(sessionId: string | undefined): void {
    this.watched.push(sessionId);
  }

  retry(sessionId: string): void {
    this.retried.push(sessionId);
  }

  publish(sessionId: string, load: TodosLoad): void {
    this.signalOf(sessionId).set(load);
  }

  private signalOf(sessionId: string): WritableSignal<TodosLoad> {
    const existing = this.loads.get(sessionId);
    if (existing) return existing;
    const created = signal<TodosLoad>({ kind: 'ready', todos: null });
    this.loads.set(sessionId, created);
    return created;
  }
}

export const SESSION_TODOS_SOURCE = new InjectionToken<SessionTodosSource>('SESSION_TODOS_SOURCE');
