import * as z from 'zod';

/** What can own a secret: a playbook, an integration connection or a trigger. */
export const SECRET_SCOPE_KINDS = ['playbook', 'connection', 'trigger'] as const;
export type SecretScopeKind = (typeof SECRET_SCOPE_KINDS)[number];

/** All that anyone but the human who set it learns about a secret: whether this device holds a value. */
export const SECRET_STATUSES = ['stored', 'missing'] as const;
export type SecretStatus = (typeof SECRET_STATUSES)[number];

export type SecretScope = { kind: SecretScopeKind; id: string };

export const MAX_SECRET_VALUE_CHARS = 8192;

/** The body of a set: the value, nothing else. It travels in the body only, never in the query string or the arguments of a command. */
export const SetSecretBodySchema = z.object({ value: z.string().max(MAX_SECRET_VALUE_CHARS) }).strict();

export interface SecretStatusAnswer {
  scopeKind: SecretScopeKind;
  scopeId: string;
  name: string;
  status: SecretStatus;
}

/** The header that carries the single-use operator nonce a desktop command minted; the REST set and clear refuse a request without a live one. */
export const OPERATOR_NONCE_HEADER = 'x-openfleet-operator-nonce';
