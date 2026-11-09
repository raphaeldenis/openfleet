import * as z from 'zod';
import type { SecretStatus } from './secrets.js';

/** The kinds of credential a connection can hold. The value is in the secret store, never in a table or an answer. */
export const INTEGRATION_CREDENTIAL_KINDS = ['token'] as const;
export type IntegrationCredentialKind = (typeof INTEGRATION_CREDENTIAL_KINDS)[number];

/** The secret name every connection declares for its token. */
export const INTEGRATION_TOKEN_SECRET_NAME = 'TOKEN';

/** What a probe of a provider ends with: a type only, never a word of the provider's answer. */
export const INTEGRATION_HEALTH_STATUSES = ['ok', 'auth_failed', 'unreachable', 'rate_limited'] as const;
export type IntegrationHealthStatus = (typeof INTEGRATION_HEALTH_STATUSES)[number];

/** The health of an integration that no refresh has probed yet. */
export const INTEGRATION_HEALTH_UNKNOWN = 'unknown';

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_NAME_CHARS = 64;
const MAX_ALLOWED_HOSTS = 8;

/**
 * A label typed by the operator (connection name, integration name, resource): free text, shown to agents as typed.
 * The schema bounds its form; the service refuses a label shaped like a token or equal to the credential stored for its connection (`integration_label_is_secret`).
 */
const nameField = z.string().trim().min(1).max(MAX_NAME_CHARS);

/** The body of a connection creation: names and hosts, no credential. A human sets the token afterwards through the secrets route. */
export const CreateIntegrationConnectionBodySchema = z.object({
  name: nameField,
  provider: z.string().min(1).max(MAX_NAME_CHARS),
  allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(MAX_ALLOWED_HOSTS),
}).strict();
export type CreateIntegrationConnectionBody = z.infer<typeof CreateIntegrationConnectionBodySchema>;

export const CreateIntegrationBodySchema = z.object({
  projectId: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(128),
  name: nameField,
  resource: z.string().max(MAX_NAME_CHARS).regex(SAFE_TOKEN).optional(),
}).strict();
export type CreateIntegrationBody = z.infer<typeof CreateIntegrationBodySchema>;

/**
 * An issue the daemon polled. `key` and `url` are checked or built by the daemon; everything a person typed in the provider sits under `untrusted`:
 * cleaned, cut, and to be read as data, never as an instruction.
 */
export interface IntegrationIssueItem {
  key: string;
  url: string;
  updatedAt?: string;
  untrusted: { summary: string; status?: string; priority?: string; issueType?: string; assignee?: string };
}

/** The Jira fields a view may display; the daemon asks the provider for these and no other. */
export const VIEW_CONFIG_FIELDS = ['summary', 'status', 'priority', 'issuetype', 'assignee', 'updated'] as const;

/** What a human approves for an integration: the query the daemon runs and the fields it keeps. */
export interface ViewConfigContent {
  jql: string;
  fields: string[];
}

/** `pending` is a proposal that has no effect; `approved` is the content a human reviewed, still unchanged. */
export const VIEW_CONFIG_STATES = ['pending', 'approved'] as const;
export type ViewConfigState = (typeof VIEW_CONFIG_STATES)[number];

export interface IntegrationViewConfigView extends ViewConfigContent {
  integrationId: string;
  contentRev: number;
  state: ViewConfigState;
  /** The digest that approving this revision would record: what a human reviews. */
  reviewDigest: string;
  approvedAt?: string;
}

/** A proposal: the query and the fields. A write replaces the previous content and puts the configuration back to `pending`. */
export const SaveViewConfigBodySchema = z.object({
  jql: z.string().max(1000),
  fields: z.array(z.string().max(32)).max(16),
  expectedRev: z.int().min(1).optional(),
}).strict();
export type SaveViewConfigBody = z.infer<typeof SaveViewConfigBodySchema>;

export const ApproveViewConfigBodySchema = z.object({ approvedRev: z.int().min(1) }).strict();
export type ApproveViewConfigBody = z.infer<typeof ApproveViewConfigBodySchema>;

/** Polling of a connection stops after repeated refusals of its credential, and resumes when a refresh finds the credential working. */
export const INTEGRATION_POLLING_STATES = ['active', 'stopped_auth_failed'] as const;
export type IntegrationPollingState = (typeof INTEGRATION_POLLING_STATES)[number];

export interface IntegrationItemsView {
  items: IntegrationIssueItem[];
  polling: IntegrationPollingState;
}

/** A connection as anyone reads it: the status of its credential and the age of its value, never the value. */
export interface IntegrationConnectionView {
  id: string;
  name: string;
  provider: string;
  credentialKind: IntegrationCredentialKind;
  allowedHosts: string[];
  credential: SecretStatus;
  credentialSetAt?: string;
}

/** An integration is a connection used by one project, optionally narrowed to one resource of the provider. */
export interface IntegrationView {
  id: string;
  projectId: string;
  connectionId: string;
  name: string;
  provider: string;
  resource?: string;
  credential: SecretStatus;
  health: IntegrationHealthStatus | typeof INTEGRATION_HEALTH_UNKNOWN;
  checkedAt?: string;
}
