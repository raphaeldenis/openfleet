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
