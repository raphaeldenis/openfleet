import { Injectable, computed, effect, inject, signal, untracked, type Signal } from '@angular/core';
import { MANAGER_ROLE } from '@openfleet/shared';
import { ApiError,FleetApiService } from '../../core/fleet-api.service';
import { copyFor, retryOfError } from '../../core/error-copy';
import { FleetEventsService } from '../../core/fleet-events.service';
import { childrenProgressOf } from './children-progress';
import type { ChildrenLoad, SessionTodosSource, TodosLoad } from './session-todos-source';
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
  private readonly childrenBySession = new Map<string, Signal<ChildrenLoad>>();
  private readonly connectionEpochOfLastRequest = new Map<string, number>();
  private readonly latestRequestNumberBySession = new Map<string, number>();
  private requestCount = 0;

  constructor() {
    effect(() => {
      const retainedSessionIds = this.events.sessionIdsWithRetainedTodos();
      untracked(() => this.releaseSessionsOutsideTheDaemonsRetention(retainedSessionIds));
    });
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

  childrenOf(managerId: string): Signal<ChildrenLoad> {
    const existing = this.childrenBySession.get(managerId);
    if (existing) return existing;
    const created = computed<ChildrenLoad>(() => {
      const sessions = this.events.sessions();
      const isManager = sessions.some((session) => session.id === managerId && session.role === MANAGER_ROLE);
      if (isManager && this.daemonLacksTodos()) return { kind: 'unsupported' };
      return { kind: 'ready', children: childrenProgressOf(managerId, sessions, this.events.todoSummaries()) };
    });
    this.childrenBySession.set(managerId, created);
    return created;
  }

  watch(sessionId: string | undefined): void {
    this.watchedSessionId.set(sessionId);
    this.events.keepTodosOf(sessionId);
  }

  retry(sessionId: string): void {
    this.failures.update((all) => withoutKey(all, sessionId));
    void this.request(sessionId, this.events.reconnectCount());
  }

  private daemonLacksTodos(): boolean {
    return this.events.snapshotReceived() && !this.events.todosReported();
  }

  private readLoad(sessionId: string): TodosLoad {
    if (this.daemonLacksTodos()) return { kind: 'unsupported' };
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
    const requestNumber = ++this.requestCount;
    this.latestRequestNumberBySession.set(sessionId, requestNumber);
    const isSupersededByANewerRequest = () => this.latestRequestNumberBySession.get(sessionId) !== requestNumber;
    try {
      const todos = await this.api.getSessionTodos(sessionId);
      const wasOvertakenByAnEvent = this.events.todoEventCount(sessionId) !== eventsSeenBeforeRequest;
      if (isSupersededByANewerRequest() || wasOvertakenByAnEvent) return;
      this.events.storeFetchedTodos(todos);
    } catch (error) {
      if (isSupersededByANewerRequest()) return;
      this.failures.update((all) => new Map(all).set(sessionId, failureOf(error, listBeforeRequest)));
    }
  }

  private releaseSessionsOutsideTheDaemonsRetention(retainedSessionIds: ReadonlySet<string>): void {
    const watchedSessionId = this.watchedSessionId();
    const isReleased = (sessionId: string) => !retainedSessionIds.has(sessionId) && sessionId !== watchedSessionId;
    for (const perSession of [this.loadsBySession, this.connectionEpochOfLastRequest, this.latestRequestNumberBySession]) {
      for (const sessionId of [...perSession.keys()]) if (isReleased(sessionId)) perSession.delete(sessionId);
    }
    this.failures.update((all) => new Map([...all].filter(([sessionId]) => !isReleased(sessionId))));
  }
}

function withoutKey<V>(all: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  const next = new Map(all);
  next.delete(key);
  return next;
}
