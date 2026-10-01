import { Injectable, computed, effect, inject, signal, untracked, type Signal } from '@angular/core';
import { ApiError, FleetApiService } from '../../core/fleet-api.service';
import { copyFor } from '../../core/error-copy';
import { FleetEventsService } from '../../core/fleet-events.service';
import type { SessionTodosSource, TodosLoad } from './session-todos-source';

type FailedLoad = Extract<TodosLoad, { kind: 'error' }>;
const LOADING: TodosLoad = { kind: 'loading' };

function failedLoadOf(error: unknown): FailedLoad {
  const retryHint = error instanceof ApiError ? error.envelope?.retry : undefined;
  return { kind: 'error', text: copyFor(error, { action: 'load_todos' }).text, retryable: retryHint !== 'never' };
}

/** Reads a session's todos from the events the daemon pushes, and asks over REST once for the session on screen. */
@Injectable({ providedIn: 'root' })
export class LiveSessionTodosSource implements SessionTodosSource {
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  private readonly watchedSessionId = signal<string | undefined>(undefined);
  private readonly failures = signal<ReadonlyMap<string, FailedLoad>>(new Map());
  private readonly loadsBySession = new Map<string, Signal<TodosLoad>>();
  private readonly connectionEpochOfLastRequest = new Map<string, number>();

  constructor() {
    effect(() => {
      const sessionId = this.watchedSessionId();
      const connectionEpoch = this.events.reconnectCount();
      if (sessionId) untracked(() => this.loadOnce(sessionId, connectionEpoch));
    });
  }

  loadOf(sessionId: string): Signal<TodosLoad> {
    const existing = this.loadsBySession.get(sessionId);
    if (existing) return existing;
    const created = computed(() => this.readLoad(sessionId));
    this.loadsBySession.set(sessionId, created);
    return created;
  }

  watch(sessionId: string | undefined): void {
    this.watchedSessionId.set(sessionId);
  }

  retry(sessionId: string): void {
    this.failures.update((all) => withoutKey(all, sessionId));
    void this.request(sessionId, this.events.reconnectCount());
  }

  private readLoad(sessionId: string): TodosLoad {
    const isSnapshotWithoutTodos = this.events.snapshotReceived() && !this.events.todosReported();
    if (isSnapshotWithoutTodos) return { kind: 'unsupported' };
    const todos = this.events.todos().get(sessionId);
    if (todos) return { kind: 'ready', todos: todos.source === null ? null : todos };
    return this.failures().get(sessionId) ?? LOADING;
  }

  private loadOnce(sessionId: string, connectionEpoch: number): void {
    const isAlreadyRequestedOnThisConnection = this.connectionEpochOfLastRequest.get(sessionId) === connectionEpoch;
    if (isAlreadyRequestedOnThisConnection) return;
    const isKnownFromLiveEvents = this.events.todoEventCount(sessionId) > 0 && connectionEpoch === 0;
    if (isKnownFromLiveEvents) return;
    void this.request(sessionId, connectionEpoch);
  }

  private async request(sessionId: string, connectionEpoch: number): Promise<void> {
    this.connectionEpochOfLastRequest.set(sessionId, connectionEpoch);
    const eventsSeenBeforeRequest = this.events.todoEventCount(sessionId);
    try {
      const todos = await this.api.getSessionTodos(sessionId);
      const wasOvertakenByAnEvent = this.events.todoEventCount(sessionId) !== eventsSeenBeforeRequest;
      if (!wasOvertakenByAnEvent) this.events.storeFetchedTodos(todos);
    } catch (error) {
      this.failures.update((all) => new Map(all).set(sessionId, failedLoadOf(error)));
    }
  }
}

function withoutKey<V>(all: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  const next = new Map(all);
  next.delete(key);
  return next;
}
