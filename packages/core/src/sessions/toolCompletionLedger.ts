import type { NotificationTrigger } from '@openfleet/shared';
import type { SessionInput } from './stateMachine.js';
import { toolCompletionBy } from './notificationTriggers.js';

const MAX_REMEMBERED_TOOL_USES_PER_SESSION = 200;

/** Remembers the most recent ids only: the oldest one is forgotten first. */
class RecentIds {
  private readonly ids = new Set<string>();

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size <= MAX_REMEMBERED_TOOL_USES_PER_SESSION) return;
    const [oldest] = this.ids;
    if (oldest !== undefined) this.ids.delete(oldest);
  }
}

/**
 * Judges each tool hook once: a tool run is announced a single time, however often its hook is replayed,
 * and a run that a sub-agent started stays silent even when its PostToolUse does not name the sub-agent.
 */
export class ToolCompletionLedger {
  private readonly announcedBySession = new Map<string, RecentIds>();
  private readonly subAgentRunsBySession = new Map<string, RecentIds>();

  judge(sessionId: string, input: SessionInput): NotificationTrigger | undefined {
    this.rememberSubAgentRun(sessionId, input);
    const trigger = toolCompletionBy({ sessionId, input });
    if (trigger?.category !== 'toolCompletion') return undefined;
    const isRunBySubAgent = this.recentIdsOf(this.subAgentRunsBySession, sessionId).has(trigger.toolUseId);
    const isAlreadyAnnounced = this.recentIdsOf(this.announcedBySession, sessionId).has(trigger.toolUseId);
    if (isRunBySubAgent || isAlreadyAnnounced) return undefined;
    this.recentIdsOf(this.announcedBySession, sessionId).add(trigger.toolUseId);
    return trigger;
  }

  forget(sessionId: string): void {
    this.announcedBySession.delete(sessionId);
    this.subAgentRunsBySession.delete(sessionId);
  }

  private rememberSubAgentRun(sessionId: string, input: SessionInput): void {
    if (input.kind !== 'hook' || input.event.hook_event_name !== 'PreToolUse') return;
    const { tool_use_id: toolUseId, agent_id: agentId } = input.event;
    const isSubAgentRunWithId = agentId !== undefined && toolUseId !== undefined;
    if (isSubAgentRunWithId) this.recentIdsOf(this.subAgentRunsBySession, sessionId).add(toolUseId);
  }

  private recentIdsOf(bySession: Map<string, RecentIds>, sessionId: string): RecentIds {
    const known = bySession.get(sessionId);
    if (known) return known;
    const created = new RecentIds();
    bySession.set(sessionId, created);
    return created;
  }
}
