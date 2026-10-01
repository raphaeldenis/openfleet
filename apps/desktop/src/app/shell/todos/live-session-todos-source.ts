import { Injectable, computed, effect, inject, signal, untracked, type Signal } from '@angular/core';
import { ApiError, FleetApiService } from '../../core/fleet-api.service';
import { copyFor, retryOfError } from '../../core/error-copy';
import { FleetEventsService } from '../../core/fleet-events.service';
import type { SessionTodosSource, TodosLoad } from './session-todos-source';
import type { SessionTodos } from './todos.adapter';

type FailedLoad = Extract<TodosLoad, { kind: 'error' }>;
const LOADING: TodosLoad = { kind: 'loading' };
const NO_LIST: TodosLoad = { kind: 'ready', todos: null };
const HTTP_NOT_FOUND = 404;

/** A failed request, remembered with the list the session had when it failed: a newer list makes the failure obsolete. */
interface Failure {
  readonly load: FailedLoad;
  readonly sessionIsGone: boolean;
  readonly listWhenFailed: SessionTodos | undefined;
}

function failureOf(error: unknown, listWhenFailed: SessionTodos | undefined): Failure {
  const load: FailedLoad = { kind: 'error', text: copyFor(error, { action: 'load_todos' }).text, retryable: retryOfError(error) !== 'never' };
  const sessionIsGone = error instanceof ApiError && error.status === HTTP_NOT_FOUND;
  return { load, sessionIsGone, listWhenFailed };
}

/** Reads a session's todos from the events the daemon pushes, and asks over REST once for the session on screen. */
@Injectable({ providedIn: 'root' })
export class LiveSessionTodosSource implements SessionTodosSource {
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  private readonly watchedSessionId = signal<string | undefined>(undefined);
  private readonly failures = signal<ReadonlyMap<string, Failure>>(new Map());
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
    const cached = this.events.todos().get(sessionId);
    const failure = this.failures().get(sessionId);
    const isFailureOfCurrentList = failure !== undefined && failure.listWhenFailed === cached;
    if (!cached) return isFailureOfCurrentList ? failure.load : LOADING;
    if (cached.source === null) return NO_LIST;
    if (!isFailureOfCurrentList) return { kind: 'ready', todos: cached };
    return failure.sessionIsGone ? NO_LIST : { kind: 'ready', todos: { ...cached, stale: true } };
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
    const listBeforeRequest = this.events.todos().get(sessionId);
    try {
      const todos = await this.api.getSessionTodos(sessionId);
      const wasOvertakenByAnEvent = this.events.todoEventCount(sessionId) !== eventsSeenBeforeRequest;
      if (!wasOvertakenByAnEvent) this.events.storeFetchedTodos(todos);
    } catch (error) {
      this.failures.update((all) => new Map(all).set(sessionId, failureOf(error, listBeforeRequest)));
    }
  }
}

function withoutKey<V>(all: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  const next = new Map(all);
  next.delete(key);
  return next;
}
