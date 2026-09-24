import type { DatabaseSync } from 'node:sqlite';
import type { Session, SessionSpec } from '@openfleet/shared';
import { EventBus } from '../events/eventBus.js';
import { createWorktree } from '../git/worktrees.js';
import type { Harness, HarnessHandle } from '../harness/harness.js';
import { newId, newToken } from '../ids.js';
import { MessageQueue } from './messageQueue.js';
import { SessionRepository } from './sessionRepository.js';
import { canDeliverNow, nextState, type SessionInput } from './stateMachine.js';

export interface SessionServiceDeps { db: DatabaseSync; bus: EventBus; harnesses: Harness[]; baseUrl: string; worktreesRoot: string }

const OUTPUT_BUFFER_LIMIT = 200 * 1024;
const DEFAULT_CLOSE_ESCALATE_MS = 5000;

function waitForExit(handle: HarnessHandle): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = handle.onExit(() => { unsubscribe(); resolve(); });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOW_SURROGATE_RANGE = { min: 0xdc00, max: 0xdfff };

function trimToTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const start = text.length - maxLength;
  const startsMidSurrogatePair = text.charCodeAt(start) >= LOW_SURROGATE_RANGE.min && text.charCodeAt(start) <= LOW_SURROGATE_RANGE.max;
  return text.slice(startsMidSurrogatePair ? start + 1 : start);
}

export class SessionService {
  private readonly repo: SessionRepository;
  private readonly queue: MessageQueue;
  private readonly handles = new Map<string, HarnessHandle>();
  private readonly outputBuffers = new Map<string, string>();

  constructor(private readonly deps: SessionServiceDeps) {
    this.repo = new SessionRepository(deps.db);
    this.queue = new MessageQueue(deps.db);
  }

  async create(spec: SessionSpec): Promise<Session> {
    const id = newId();
    const hookToken = newToken();
    const mcpToken = newToken();
    const now = new Date().toISOString();
    this.repo.insert({ id, name: spec.name, emoji: spec.emoji, directory: spec.directory, worktree: null, model: spec.model ?? null,
      parent_id: spec.parentId ?? null, role: spec.role ?? null, harness: spec.harness, state: 'starting', state_since: now, hook_token: hookToken, mcp_token: mcpToken,
      permission_mode: null, created_at: now });
    const harness = this.harnessFor(spec.harness);
    const handle = harness.start({
      sessionId: id, directory: spec.directory, model: spec.model, seededPrompt: spec.seededPrompt,
      hookUrl: `${this.deps.baseUrl}/hooks/${hookToken}`, mcpUrl: `${this.deps.baseUrl}/mcp`, mcpToken, displayName: `${spec.emoji} ${spec.name}`,
    });
    this.handles.set(id, handle);
    handle.onData((data) => {
      this.appendOutput(id, data);
      this.deps.bus.emit({ type: 'session.output', sessionId: id, data });
    });
    handle.onExit((exitCode) => this.markClosed(id, exitCode));
    const session = this.repo.get(id)!;
    this.deps.bus.emit({ type: 'session.created', session });
    return session;
  }

  async createInWorktree(spec: SessionSpec & { repoPath: string; branchName: string }): Promise<Session> {
    const worktree = await createWorktree({ repoPath: spec.repoPath, branchName: spec.branchName, worktreesRoot: this.deps.worktreesRoot });
    return this.create({ ...spec, directory: worktree.path });
  }

  sendMessage(input: { sessionId: string; body: string; fromSessionId?: string }): { status: 'delivered' | 'queued'; messageId: string } {
    const session = this.require(input.sessionId);
    const message = this.queue.enqueue(input);
    if (!canDeliverNow(session.state)) {
      this.deps.bus.emit({ type: 'message.queued', sessionId: session.id, messageId: message.id });
      return { status: 'queued', messageId: message.id };
    }
    this.deliver(session.id, message.id, message.body);
    return { status: 'delivered', messageId: message.id };
  }

  applyInput(sessionId: string, input: SessionInput): void {
    const session = this.require(sessionId);
    const state = nextState(session.state, input);
    if (state === session.state) return;
    if (state === 'closed') {
      // harness_exit means the process already died — markClosed only records it. Any other path to
      // closed (SessionEnd, etc.) is not proof the process actually exited, so it must go through the
      // real close() (kill, await exit, escalate to SIGKILL) or the PTY is orphaned.
      if (input.kind === 'harness_exit') this.markClosed(sessionId, undefined);
      else void this.close(sessionId);
      return;
    }
    const since = new Date().toISOString();
    this.repo.setState(sessionId, state, since);
    this.deps.bus.emit({ type: 'session.state', sessionId, state, stateSince: since });
    if (canDeliverNow(state)) this.flushOne(sessionId);
  }

  recentOutput(sessionId: string): string { return this.outputBuffers.get(sessionId) ?? ''; }
  tokens(sessionId: string): { hookToken: string; mcpToken: string } | undefined { return this.repo.tokens(sessionId); }
  // ponytail: exposes the raw harness handle to the REST edge for test-only routes (fake-output); scope down if the daemon leaves localhost
  harnessHandle(sessionId: string): HarnessHandle | undefined { return this.handles.get(sessionId); }
  writeRaw(sessionId: string, data: string): void { this.handles.get(sessionId)?.write(data); }
  resize(sessionId: string, cols: number, rows: number): void { this.handles.get(sessionId)?.resize(cols, rows); }
  async close(sessionId: string, options?: { escalateAfterMs?: number }): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    const escalateAfterMs = options?.escalateAfterMs ?? DEFAULT_CLOSE_ESCALATE_MS;
    const exited = waitForExit(handle);
    handle.kill();
    const exitedGracefully = await Promise.race([exited.then(() => true), delay(escalateAfterMs).then(() => false)]);
    if (exitedGracefully) return;
    const exitedAfterForce = waitForExit(handle);
    handle.kill({ force: true });
    await exitedAfterForce;
  }

  async closeAll(): Promise<void> {
    const openSessionIds = [...this.handles.keys()];
    await Promise.all(openSessionIds.map((id) => this.close(id)));
  }
  get(id: string): Session | undefined { return this.repo.get(id); }
  list(): Session[] { return this.repo.list(); }
  byHookToken(token: string): Session | undefined { return this.repo.byHookToken(token); }
  byMcpToken(token: string): Session | undefined { return this.repo.byMcpToken(token); }

  // ponytail: 200 KB ring buffer, persist scrollback to disk if replays matter more
  private appendOutput(sessionId: string, data: string): void {
    const combined = (this.outputBuffers.get(sessionId) ?? '') + data;
    this.outputBuffers.set(sessionId, trimToTail(combined, OUTPUT_BUFFER_LIMIT));
  }

  // ponytail: one message per turn; batch delivery if queues grow
  private flushOne(sessionId: string): void {
    const pending = this.queue.nextPending(sessionId);
    if (!pending) return;
    this.deliver(sessionId, pending.id, pending.body);
  }

  private deliver(sessionId: string, messageId: string, body: string): void {
    this.handles.get(sessionId)?.write(`${body}\r`);
    this.queue.markDelivered(messageId);
    this.deps.bus.emit({ type: 'message.delivered', sessionId, messageId });
  }

  private markClosed(sessionId: string, exitCode: number | undefined): void {
    const session = this.repo.get(sessionId);
    if (!session || session.state === 'closed') return;
    this.repo.setClosed(sessionId, exitCode, new Date().toISOString());
    this.handles.delete(sessionId);
    this.deps.bus.emit({ type: 'session.closed', sessionId, exitCode });
  }

  private harnessFor(id: string): Harness {
    const harness = this.deps.harnesses.find((h) => h.id === id);
    if (!harness) throw new Error(`unknown harness: ${id}`);
    return harness;
  }

  private require(id: string): Session {
    const session = this.repo.get(id);
    if (!session) throw new Error(`unknown session: ${id}`);
    return session;
  }
}
