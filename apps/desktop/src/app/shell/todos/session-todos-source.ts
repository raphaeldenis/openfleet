import { InjectionToken, signal, type Signal, type WritableSignal } from '@angular/core';
import type { SessionTodos } from './todos.adapter';

export type TodosLoad =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'unsupported' }
  | { kind: 'ready'; todos: SessionTodos | null };

/** Port: what the Todos tab reads. The HTTP/WS adapter (TODOS-03 part 2) implements it. */
export interface SessionTodosSource {
  loadOf(sessionId: string): Signal<TodosLoad>;
  retry(sessionId: string): void;
}

/** In-memory source for tests and the dev fixture; an unknown session reads as "no list yet". */
export class InMemorySessionTodosSource implements SessionTodosSource {
  readonly retried: string[] = [];
  private readonly loads = new Map<string, WritableSignal<TodosLoad>>();

  loadOf(sessionId: string): Signal<TodosLoad> {
    return this.signalOf(sessionId);
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

export const SESSION_TODOS_SOURCE = new InjectionToken<SessionTodosSource>('SESSION_TODOS_SOURCE', {
  providedIn: 'root',
  factory: () => new InMemorySessionTodosSource(),
});
