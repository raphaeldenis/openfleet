import type { DenialOutcome, DenialSource, DeniedCommand, HarnessId, PolicyActor } from '@openfleet/shared';

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
