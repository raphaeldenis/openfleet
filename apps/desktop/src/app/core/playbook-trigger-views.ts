import type { PlaybookFlow, PlaybookInputDeclaration, PlaybookOrigin, PlaybookPolicy, PlaybookVersionSource, SecretStatus, TriggerCondition, TriggerPolicy, TriggerRun, TriggerWhen } from '@openfleet/shared';

/** A playbook as GET /api/playbooks answers: the record, the secret names its cells reference and the declared names no cell references any more. */
export interface PlaybookView {
  id: string;
  projectId: string;
  name: string;
  inputs: PlaybookInputDeclaration[];
  flow: PlaybookFlow;
  contentRev: number;
  agentLocked: boolean;
  policy: PlaybookPolicy;
  approvedDigest: string | null;
  approvedAt: string | null;
  origin: PlaybookOrigin;
  updatedAt: string;
  secrets: string[];
  unreferencedSecrets: string[];
}

export interface PlaybookVersionSummary {
  rev: number;
  name: string;
  sha256: string;
  source: PlaybookVersionSource;
  approvedDigest: string | null;
  createdAt: string;
  cellCount: number;
}

export interface PlaybookVersionList {
  currentContentRev: number;
  versions: PlaybookVersionSummary[];
}

export interface PlaybookVersionContent extends PlaybookVersionSummary {
  inputs: PlaybookInputDeclaration[];
  flow: PlaybookFlow;
}

export interface PlaybookSecretStatus {
  name: string;
  status: SecretStatus;
}

export interface TriggerView {
  id: string;
  projectId: string;
  ownerManagerId: string | null;
  title: string;
  when: TriggerWhen;
  conditions: TriggerCondition[];
  run: TriggerRun;
  policy: TriggerPolicy;
  contentRev: number;
  armedAt: string | null;
  approvedRev: number | null;
  approvedGraphDigest: string | null;
  /** The digest arming would record for the content as it stands; absent from a daemon that does not send it. */
  reviewDigest?: string;
  updatedAt: string;
}
