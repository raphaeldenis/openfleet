import type { DatabaseSync } from 'node:sqlite';
import type { Approval } from '@openfleet/shared';
import { EventBus } from '../events/eventBus.js';
import { newId } from '../ids.js';

export type ApprovalDecision = 'allow' | 'deny' | 'ask';

export class ApprovalError extends Error {
  constructor(public readonly code: 'not_found' | 'already_resolved', message: string) { super(message); }
}

const DEFAULT_TIMEOUT_MS = 540_000;

export class ApprovalService {
  private readonly waiters = new Map<string, (d: ApprovalDecision) => void>();
  private readonly timeoutMs: number;
  lastId = '';

  constructor(private readonly deps: { db: DatabaseSync; bus: EventBus; timeoutMs?: number }) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Decoupled from SessionService through the bus, the same way the WS broadcast is: a session closing
    // or relaunching moots whatever approval was still gating it (AUD-07).
    this.deps.bus.subscribe((event) => {
      if (event.type === 'session.closed') this.expirePendingForSession(event.sessionId, 'session closed');
      if (event.type === 'session.relaunching') this.expirePendingForSession(event.sessionId, 'session relaunching');
    });
  }

  request(input: { sessionId: string; toolName: string; toolInput: unknown }): Promise<ApprovalDecision> {
    const approval: Approval = { id: newId(), sessionId: input.sessionId, toolName: input.toolName, toolInput: input.toolInput, status: 'pending', createdAt: new Date().toISOString() };
    this.lastId = approval.id;
    this.deps.db.prepare('INSERT INTO approvals (id, session_id, tool_name, tool_input_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(approval.id, approval.sessionId, approval.toolName, JSON.stringify(approval.toolInput ?? null), approval.status, approval.createdAt);
    this.deps.bus.emit({ type: 'approval.created', approval });

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => this.expireWithReason(approval.id, 'no decision before hook timeout'), this.timeoutMs);
      this.waiters.set(approval.id, (decision) => { clearTimeout(timer); resolve(decision); });
    });
  }

  // Called at daemon startup (main.ts, before any hook can reach the fresh instance): a row still 'pending'
  // from before the restart has no live waiter any more — the process that would have resolved it died
  // with the old daemon — so it would otherwise sit pending forever, never decidable and never reopenable.
  expireAllPending(reason: string): void {
    for (const approval of this.listPending()) this.expireWithReason(approval.id, reason);
  }

  // Called from SessionService when a session closes or relaunches (AUD-07): whatever approval was still
  // gating it is now moot, and its requester (the hook still awaiting a decision) must not be left hanging
  // for the full request() timeout.
  expirePendingForSession(sessionId: string, reason: string): void {
    for (const approval of this.listPending().filter((a) => a.sessionId === sessionId)) this.expireWithReason(approval.id, reason);
  }

  decide(input: { approvalId: string; behavior: 'allow' | 'deny'; reason?: string }): Approval {
    const current = this.get(input.approvalId);
    if (!current) throw new ApprovalError('not_found', `approval not found: ${input.approvalId}`);
    if (current.status !== 'pending') throw new ApprovalError('already_resolved', `approval ${input.approvalId} is ${current.status}`);
    const status = input.behavior === 'allow' ? 'allowed' : 'denied';
    const resolved = this.resolve(input.approvalId, status, input.reason);
    this.waiters.get(input.approvalId)?.(input.behavior);
    this.waiters.delete(input.approvalId);
    return resolved;
  }

  listPending(): Approval[] {
    return (this.deps.db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at`).all() as unknown as Row[]).map(toApproval);
  }

  private get(id: string): Approval | undefined {
    const row = this.deps.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  // Resolves the waiting hook (if the process that requested it, and this ApprovalService instance, are
  // still both alive — a daemon-restart expiry has no waiter left to call) the same way a timed-out
  // approval always has: 'ask', which the CLI reads as "fall back to your own interactive prompt".
  private expireWithReason(id: string, reason: string): void {
    if (this.get(id)?.status !== 'pending') return;
    this.resolve(id, 'expired', reason);
    this.waiters.get(id)?.('ask');
    this.waiters.delete(id);
  }

  private resolve(id: string, status: Approval['status'], reason?: string): Approval {
    this.deps.db.prepare('UPDATE approvals SET status = ?, reason = ?, resolved_at = ? WHERE id = ?').run(status, reason ?? null, new Date().toISOString(), id);
    const approval = this.get(id)!;
    this.deps.bus.emit({ type: 'approval.resolved', approval });
    return approval;
  }
}

interface Row { id: string; session_id: string; tool_name: string; tool_input_json: string; status: Approval['status']; reason: string | null; created_at: string; resolved_at: string | null }
const toApproval = (r: Row): Approval => ({ id: r.id, sessionId: r.session_id, toolName: r.tool_name, toolInput: JSON.parse(r.tool_input_json), status: r.status, reason: r.reason ?? undefined, createdAt: r.created_at, resolvedAt: r.resolved_at ?? undefined });
