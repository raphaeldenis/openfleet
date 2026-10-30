import { dirname, join } from 'node:path';
import {
  WORKING_STATE_TOOL_NAMES,
  type ClaudeHookEvent, type PermissionRequestHookOutput, type PolicyActor, type PolicyPresence, type PolicyRequest, type PolicySource, type PolicyVerdict,
  type PreToolUseHookOutput, type ServerEvent, type Session,
} from '@openfleet/shared';
import { isAttendedManager, managerAskUserRefusalOf } from '../../escalation/managerAskUserGuard.js';
import { log } from '../../logger.js';
import type { DegradedRegistry } from '../../process/degradedRegistry.js';
import type { CommandPolicySettings, PolicyEvaluate } from '../../policy/commandPolicySettings.js';
import { ASK_USER_QUESTION_TOOL, FINDINGS_GATE_RULE_ID, ROOT_MANAGER_ASK_USER_EVENT_ID } from '../../policy/defaultCommandPolicy.js';
import { pullRequestCreationsOf } from '../../policy/ghPrCreate.js';
import { profileNameOf } from '../../policy/policyEvaluator.js';
import type { FindingsGate, FindingsGateEnforcement, GateAnswer } from '../../review/findingsGate.js';
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
  /** `list` lets a SendMessage addressed to a manager by name be recognised; absent, only uuids are. */
  sessions: { get(id: string): Session | undefined; sendMessage(input: { sessionId: string; body: string }): unknown; list?(): readonly Session[] };
  isManager: (sessionId: string) => boolean;
  journal: DenialJournal;
  bus: { emit(event: ServerEvent): void };
  repeatGuard: RefusalRepeatGuard;
  degraded?: Pick<DegradedRegistry, 'recordHookFailOpen'>;
  /** Runs the work that must not delay the hook answer; the daemon uses the next turn of the event loop. */
  afterAnswer?: (work: () => void) => void;
  /** Absent, a call matched by the findings gate rule is judged by the policy alone. */
  findingsGate?: { gate: Pick<FindingsGate, 'check'>; enforcement: FindingsGateEnforcement };
}

interface Refusal { ruleId: string; reason: string; alternative: string; source: DenialDraft['decisionSource'] }

/** The rule matched the call, refusing or only observing: either way the findings gate has the last word. */
const isFindingsGateVerdict = (verdict: PolicyVerdict): boolean => {
  const isRefusedByTheRule = verdict.decision === 'deny' && verdict.ruleId === FINDINGS_GATE_RULE_ID;
  const isObservedByTheRule = verdict.decision === 'allow' && verdict.observed?.ruleId === FINDINGS_GATE_RULE_ID;
  return isRefusedByTheRule || isObservedByTheRule;
};

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

const SEND_MESSAGE_TOOL = 'SendMessage';

function recipientOf(event: ToolHookEvent): string | undefined {
  const recipient = event.tool_name === SEND_MESSAGE_TOOL && isRecord(event.tool_input) ? event.tool_input.to : undefined;
  return typeof recipient === 'string' ? recipient.trim() : undefined;
}

function toPolicyRequest(session: Session, event: ToolHookEvent, source: PolicySource, recipientNamesManager: boolean): PolicyRequest {
  const command = commandOf(event.tool_input);
  const recipient = recipientOf(event);
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
    ...(recipient === undefined ? {} : { recipient, recipientNamesManager }),
    cwd: event.cwd ?? session.directory,
    worktreeRoot: session.worktree ?? session.directory,
    scratchRoots: [],
    ...(toolResultsRoot === undefined ? {} : { toolResultsRoot }),
  };
}

/** Answers the PreToolUse and PermissionRequest hooks of a Claude session from the command policy. An undefined answer means "no opinion". */
export class ClaudePolicyHooks implements CommandPolicyHooks {
  constructor(private readonly deps: ClaudePolicyHooksDeps) {}

  onPreToolUse(session: Session, event: Extract<ToolHookEvent, { hook_event_name: 'PreToolUse' }>): PreToolUseHookOutput | undefined | Promise<PreToolUseHookOutput | undefined> {
    const questionRefusal = this.managerQuestionRefusalOf(session, event);
    if (questionRefusal !== undefined) return this.refuseManagerQuestion(session, event, questionRefusal);
    this.journalAttendedManagerQuestion(session, event);
    const verdict = this.evaluateFailingOpen(session, event, 'pre_tool_use');
    if (verdict === undefined) return undefined;
    const waitsOnFindingsGate = this.deps.findingsGate !== undefined && isFindingsGateVerdict(verdict);
    if (waitsOnFindingsGate) return this.answerFindingsGate(session, event);
    if (verdict.decision === 'allow') return this.answerAllowed(session, event, verdict);
    const refusal = this.refusalOf(session, verdict);
    if (refusal === undefined) return undefined;
    this.recordAfterAnswering(session, event, { ...refusal, outcome: 'denied' });
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: this.textOf(session, refusal) } };
  }

  /** Allows what a policy allow rule vouches for, refuses at once what a human would have been asked when a child cannot be answered; undefined leaves the call to the approval flow. */
  onPermissionRequest(session: Session, event: Extract<ToolHookEvent, { hook_event_name: 'PermissionRequest' }>): PermissionRequestHookOutput | undefined {
    const isWorkingStateTool = (WORKING_STATE_TOOL_NAMES as readonly string[]).includes(event.tool_name);
    if (isWorkingStateTool) return undefined;
    const questionRefusal = this.managerQuestionRefusalOf(session, event);
    if (questionRefusal !== undefined) {
      this.recordAfterAnswering(session, event, { ...questionRefusal, outcome: 'denied' });
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: this.textOf(session, questionRefusal) } } };
    }
    const verdict = this.evaluateFailingOpen(session, event, 'permission_request');
    const isExplicitlyAllowed = verdict?.decision === 'allow' && verdict.allowedBy !== undefined;
    if (isExplicitlyAllowed) return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    const isFindingsGateCall = verdict !== undefined && isFindingsGateVerdict(verdict);
    const policyRefusal = verdict === undefined || isFindingsGateCall ? undefined : this.refusalOf(session, verdict);
    const refusal = policyRefusal ?? this.askRefusalOf(session);
    if (refusal === undefined) return undefined;
    this.recordAfterAnswering(session, event, { ...refusal, outcome: 'denied' });
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: this.textOf(session, refusal) } } };
  }

  /** Refuses at once, whatever the policy mode, the free-text question of a manager no human accompanies; the policy rule never sees the call, so nothing is journaled twice. */
  private managerQuestionRefusalOf(session: Session, event: ToolHookEvent): Refusal | undefined {
    const refusal = managerAskUserRefusalOf({ session, toolName: event.tool_name });
    return refusal === undefined ? undefined : { ...refusal, source: 'policy' };
  }

  private refuseManagerQuestion(session: Session, event: ToolHookEvent, refusal: Refusal): PreToolUseHookOutput {
    this.recordAfterAnswering(session, event, { ...refusal, outcome: 'denied' });
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: this.textOf(session, refusal) } };
  }

  /** An attended manager has a human beside it: its question goes to the human, and the journal keeps the trace of it. */
  private journalAttendedManagerQuestion(session: Session, event: ToolHookEvent): void {
    const isAttendedManagerAsking = event.tool_name === ASK_USER_QUESTION_TOOL && isAttendedManager(session);
    if (!isAttendedManagerAsking) return;
    this.recordAfterAnswering(session, event, {
      ruleId: ROOT_MANAGER_ASK_USER_EVENT_ID, reason: 'An attended manager asked the human directly.', alternative: '', source: 'policy', outcome: 'observed',
    });
  }

  /** Opens the call when the ticket has its findings; otherwise refuses it, or only journals the refusal while the gate observes. A session not run by a manager is not judged. */
  private async answerFindingsGate(session: Session, event: Extract<ToolHookEvent, { hook_event_name: 'PreToolUse' }>): Promise<PreToolUseHookOutput | undefined> {
    const isRunByManager = session.parentId !== undefined && this.deps.isManager(session.parentId);
    if (!isRunByManager) return undefined;
    const { gate, enforcement } = this.deps.findingsGate!;
    const directory = event.cwd ?? session.directory;
    const creations = pullRequestCreationsOf(commandOf(event.tool_input) ?? '');
    const isRequestCreation = creations.length > 0;
    if (!isRequestCreation) return undefined;
    const answer = await this.checkFailingOpen(session, async () => {
      const answers = await Promise.all(creations.map(({ headBranch }) => gate.check({ directory, ...(headBranch === undefined ? {} : { headBranch }) })));
      return answers.find((candidate) => !candidate.isOpen) ?? { isOpen: true };
    });
    if (answer === undefined || answer.isOpen) return undefined;
    const refusal: Refusal = { ruleId: FINDINGS_GATE_RULE_ID, reason: answer.reason, alternative: answer.alternative, source: 'policy' };
    const isObserving = enforcement === 'observe';
    this.recordAfterAnswering(session, event, { ...refusal, outcome: isObserving ? 'observed' : 'denied' });
    if (isObserving) return undefined;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: this.textOf(session, refusal) } };
  }

  private async checkFailingOpen(session: Session, check: () => Promise<GateAnswer>): Promise<GateAnswer | undefined> {
    try {
      return await check();
    } catch (error) {
      log('warn', `findings gate check failed, letting the call through: ${error instanceof Error ? error.message : String(error)}`, session.id);
      this.deps.degraded?.recordHookFailOpen();
      return undefined;
    }
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
      const recipientNamesManager = this.namesManagerSession(recipientOf(event));
      return this.deps.evaluate(toPolicyRequest(session, event, source, recipientNamesManager), this.deps.settings().document);
    } catch (error) {
      log('warn', `command policy evaluation failed, letting the call through: ${error instanceof Error ? error.message : String(error)}`, session.id);
      this.deps.degraded?.recordHookFailOpen();
      return undefined;
    }
  }

  private namesManagerSession(recipient: string | undefined): boolean {
    if (recipient === undefined || this.deps.sessions.list === undefined) return false;
    const wanted = recipient.toLowerCase();
    return this.deps.sessions.list().some((candidate) => candidate.name.toLowerCase() === wanted && this.deps.isManager(candidate.id));
  }

  private refusalOf(session: Session, verdict: PolicyVerdict): Refusal | undefined {
    if (verdict.decision === 'deny') return { ruleId: verdict.ruleId, reason: verdict.reason, alternative: verdict.alternative, source: 'policy' };
    if (verdict.decision !== 'ask') return undefined;
    const askRefusal = this.askRefusalOf(session);
    return askRefusal === undefined ? undefined : { ...askRefusal, ruleId: verdict.ruleId, reason: verdict.reason };
  }

  private askRefusalOf(session: Session): Refusal | undefined {
    const isUnwatched = presenceOf(session) === 'unattended' && !this.deps.isManager(session.id);
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
      command: commandOf(event.tool_input) ?? filePathsOf(event.tool_input)?.join(' ') ?? recipientOf(event) ?? '',
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
