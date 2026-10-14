import { dirname, join } from 'node:path';
import {
  WORKING_STATE_TOOL_NAMES,
  type ClaudeHookEvent, type PermissionRequestHookOutput, type PolicyActor, type PolicyPresence, type PolicyRequest, type PolicySource, type PolicyVerdict,
  type PreToolUseHookOutput, type ServerEvent, type Session,
} from '@openfleet/shared';
import { log } from '../../logger.js';
import type { DegradedRegistry } from '../../process/degradedRegistry.js';
import type { CommandPolicySettings, PolicyEvaluate } from '../../policy/commandPolicySettings.js';
import { profileNameOf } from '../../policy/policyEvaluator.js';
import type { CommandPolicyHooks, DenialDraft, DenialJournal } from '../../policy/ports.js';
import { refusalTextOf } from '../../policy/refusalText.js';
import type { RefusalRepeatGuard } from '../../policy/refusalRepeatGuard.js';
import { resolveAsk } from '../../policy/unattendedResolver.js';

type ToolHookEvent = Extract<ClaudeHookEvent, { hook_event_name: 'PreToolUse' | 'PermissionRequest' }>;

const ASK_REFUSAL = {
  ruleId: 'unattended-ask-becomes-deny',
  reason: 'The CLI asked for a confirmation nobody can give.',
  alternative: 'Rephrase with read-only commands inside your working directory, or ask your manager with `message_parent`.',
};
const MAX_LINEAGE_DEPTH = 32;
const FILE_PATH_FIELDS = ['file_path', 'notebook_path'];

export interface ClaudePolicyHooksDeps {
  settings: () => CommandPolicySettings;
  evaluate: PolicyEvaluate;
  sessions: { get(id: string): Session | undefined; sendMessage(input: { sessionId: string; body: string }): unknown };
  isManager: (sessionId: string) => boolean;
  journal: DenialJournal;
  bus: { emit(event: ServerEvent): void };
  repeatGuard: RefusalRepeatGuard;
  degraded?: Pick<DegradedRegistry, 'recordHookFailOpen'>;
  /** Runs the work that must not delay the hook answer; the daemon uses the next turn of the event loop. */
  afterAnswer?: (work: () => void) => void;
}

interface Refusal { ruleId: string; reason: string; alternative: string; source: DenialDraft['decisionSource'] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function commandOf(toolInput: unknown): string | undefined {
  const command = isRecord(toolInput) ? toolInput.command : undefined;
  return typeof command === 'string' ? command : undefined;
}

function filePathsOf(toolInput: unknown): string[] | undefined {
  if (!isRecord(toolInput)) return undefined;
  const paths = FILE_PATH_FIELDS.map((field) => toolInput[field]).filter((path): path is string => typeof path === 'string');
  return paths.length === 0 ? undefined : paths;
}

/** The CLI keeps the output it persisted for a session next to the session transcript, under `<session id>/tool-results`. */
function toolResultsRootOf(event: ToolHookEvent): string | undefined {
  return event.transcript_path === undefined ? undefined : join(dirname(event.transcript_path), event.session_id, 'tool-results');
}

const presenceOf = (session: Session): PolicyPresence => (session.parentId === undefined ? 'attended' : 'unattended');
const actorOf = (event: ToolHookEvent): PolicyActor => (event.agent_id === undefined ? 'session' : 'subagent');

function toPolicyRequest(session: Session, event: ToolHookEvent, source: PolicySource): PolicyRequest {
  const command = commandOf(event.tool_input);
  const filePaths = filePathsOf(event.tool_input);
  const model = session.resolvedModel ?? session.model;
  const toolResultsRoot = toolResultsRootOf(event);
  return {
    sessionId: session.id,
    harness: session.harness,
    ...(session.role === undefined ? {} : { role: session.role }),
    ...(model === undefined ? {} : { model }),
    presence: presenceOf(session),
    actor: actorOf(event),
    source,
    toolName: event.tool_name,
    ...(command === undefined ? {} : { command }),
    ...(filePaths === undefined ? {} : { filePaths }),
    cwd: event.cwd ?? session.directory,
    worktreeRoot: session.worktree ?? session.directory,
    scratchRoots: [],
    ...(toolResultsRoot === undefined ? {} : { toolResultsRoot }),
  };
}

/** Answers the PreToolUse and PermissionRequest hooks of a Claude session from the command policy. An undefined answer means "no opinion". */
export class ClaudePolicyHooks implements CommandPolicyHooks {
  constructor(private readonly deps: ClaudePolicyHooksDeps) {}

  onPreToolUse(session: Session, event: Extract<ToolHookEvent, { hook_event_name: 'PreToolUse' }>): PreToolUseHookOutput | undefined {
    const verdict = this.evaluateFailingOpen(session, event, 'pre_tool_use');
    if (verdict === undefined) return undefined;
    if (verdict.decision === 'allow') return this.answerAllowed(session, event, verdict);
    const refusal = this.refusalOf(session, verdict);
    if (refusal === undefined) return undefined;
    this.recordAfterAnswering(session, event, { ...refusal, outcome: 'denied' });
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: this.textOf(session, refusal) } };
  }

  /** Refuses at once what a human would have been asked, when nobody can answer; undefined leaves the call to the approval flow. */
  onPermissionRequest(session: Session, event: Extract<ToolHookEvent, { hook_event_name: 'PermissionRequest' }>): PermissionRequestHookOutput | undefined {
    const isWorkingStateTool = (WORKING_STATE_TOOL_NAMES as readonly string[]).includes(event.tool_name);
    if (isWorkingStateTool) return undefined;
    const verdict = this.evaluateFailingOpen(session, event, 'permission_request');
    const policyRefusal = verdict === undefined ? undefined : this.refusalOf(session, verdict);
    const refusal = policyRefusal ?? this.askRefusalOf(session);
    if (refusal === undefined) return undefined;
    this.recordAfterAnswering(session, event, { ...refusal, outcome: 'denied' });
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: this.textOf(session, refusal) } } };
  }

  private answerAllowed(session: Session, event: ToolHookEvent, verdict: Extract<PolicyVerdict, { decision: 'allow' }>): PreToolUseHookOutput | undefined {
    if (verdict.degraded) log('warn', `command policy skipped a command over its analysis limits (${verdict.degraded})`, session.id);
    const { observed } = verdict;
    if (observed) this.recordAfterAnswering(session, event, { ruleId: observed.ruleId, reason: observed.reason, alternative: observed.alternative ?? '', source: 'policy', outcome: 'observed' });
    if (verdict.allowedBy === undefined) return undefined;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `Allowed by OpenFleet command policy [${verdict.allowedBy}].` } };
  }

  private evaluateFailingOpen(session: Session, event: ToolHookEvent, source: PolicySource): PolicyVerdict | undefined {
    try {
      return this.deps.evaluate(toPolicyRequest(session, event, source), this.deps.settings().document);
    } catch (error) {
      log('warn', `command policy evaluation failed, letting the call through: ${error instanceof Error ? error.message : String(error)}`, session.id);
      this.deps.degraded?.recordHookFailOpen();
      return undefined;
    }
  }

  private refusalOf(session: Session, verdict: PolicyVerdict): Refusal | undefined {
    if (verdict.decision === 'deny') return { ruleId: verdict.ruleId, reason: verdict.reason, alternative: verdict.alternative, source: 'policy' };
    if (verdict.decision !== 'ask') return undefined;
    const askRefusal = this.askRefusalOf(session);
    return askRefusal === undefined ? undefined : { ...askRefusal, ruleId: verdict.ruleId, reason: verdict.reason };
  }

  private askRefusalOf(session: Session): Refusal | undefined {
    const isUnwatched = presenceOf(session) === 'unattended' || this.deps.isManager(session.id);
    const { askBecomesDeny } = this.deps.settings().unattended;
    return resolveAsk({ isUnwatched, askBecomesDeny }) === 'deny' ? { ...ASK_REFUSAL, source: 'cli_ask' } : undefined;
  }

  private textOf(session: Session, refusal: Refusal): string {
    return refusalTextOf({ ruleId: refusal.ruleId, reason: refusal.reason, alternative: refusal.alternative, isUnwatched: presenceOf(session) === 'unattended' });
  }

  private recordAfterAnswering(session: Session, event: ToolHookEvent, refusal: Refusal & { outcome: DenialDraft['outcome'] }): void {
    const draft: DenialDraft = {
      sessionId: session.id,
      managerId: this.lineageRootOf(session),
      ...(session.role === undefined ? {} : { role: session.role }),
      profile: profileNameOf(session.role, this.deps.settings().document),
      harness: session.harness,
      ruleId: refusal.ruleId,
      decisionSource: refusal.source,
      outcome: refusal.outcome,
      toolName: event.tool_name,
      command: commandOf(event.tool_input) ?? filePathsOf(event.tool_input)?.join(' ') ?? '',
      ...(refusal.alternative === '' ? {} : { alternative: refusal.alternative }),
      actor: actorOf(event),
    };
    const afterAnswer = this.deps.afterAnswer ?? ((work: () => void) => void setImmediate(work));
    afterAnswer(() => this.journalAndTell(session, draft));
  }

  private journalAndTell(session: Session, draft: DenialDraft): void {
    try {
      const denial = this.deps.journal.record(draft);
      if (draft.outcome !== 'denied') return;
      this.deps.bus.emit({ type: 'command.denied', denial });
      this.tellManagerWhenStuck(session, draft);
    } catch (error) {
      log('warn', `command policy could not journal a refusal: ${error instanceof Error ? error.message : String(error)}`, session.id);
    }
  }

  private tellManagerWhenStuck(session: Session, draft: DenialDraft): void {
    const { parentId } = session;
    const hasManagerToTell = parentId !== undefined;
    const isStuck = this.deps.repeatGuard.registerAndShouldEscalate({ sessionId: session.id, ruleId: draft.ruleId });
    if (!hasManagerToTell || !isStuck) return;
    const { count, windowSeconds } = this.deps.settings().unattended.escalateAfterRepeats;
    const body = `[OpenFleet] ${session.name} (${session.id}) was refused ${count} times by the command policy rule ${draft.ruleId} within ${windowSeconds} seconds. It needs an alternative or a permission (propose_permission).`;
    try {
      this.deps.sessions.sendMessage({ sessionId: parentId, body });
    } catch (error) {
      log('warn', `command policy could not tell the manager of a stuck child: ${error instanceof Error ? error.message : String(error)}`, session.id);
    }
  }

  private lineageRootOf(session: Session): string {
    let root = session;
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH && root.parentId !== undefined; depth += 1) {
      const parent = this.deps.sessions.get(root.parentId);
      if (parent === undefined) return root.parentId;
      root = parent;
    }
    return root.id;
  }
}
