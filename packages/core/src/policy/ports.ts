import type { DenialOutcome, DenialSource, DeniedCommand, HarnessId, PermissionRequestHookOutput, PolicyActor, PreToolUseHookOutput, Session } from '@openfleet/shared';
import type { ClaudeHookEvent } from '@openfleet/shared';

type ToolHookEvent<Name extends 'PreToolUse' | 'PermissionRequest'> = Extract<ClaudeHookEvent, { hook_event_name: Name }>;

/** What the hook handler asks of a harness's policy hooks; an undefined answer means "no opinion". */
export interface CommandPolicyHooks {
  onPreToolUse(session: Session, event: ToolHookEvent<'PreToolUse'>): PreToolUseHookOutput | undefined;
  onPermissionRequest(session: Session, event: ToolHookEvent<'PermissionRequest'>): PermissionRequestHookOutput | undefined;
}

/** What the policy knows about a refusal before the journal gives it an id and a date. */
export interface DenialDraft {
  sessionId: string;
  managerId: string;
  role?: string;
  profile: string;
  harness: HarnessId;
  ruleId: string;
  decisionSource: DenialSource;
  outcome: DenialOutcome;
  toolName: string;
  /** The whole command: the journal masks secrets and keeps an excerpt. */
  command: string;
  alternative?: string;
  actor: PolicyActor;
}

export interface DenialJournal {
  record(draft: DenialDraft): DeniedCommand;
}
