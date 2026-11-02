import { canonicalJsonOf } from './canonicalDigest.js';
import { valueAtDottedPath } from './dottedPath.js';
import { KernelError } from './kernelError.js';
import { SECRET_NAME } from './secretName.js';

type TemplateToken = { raw: string; start: number } & (
  | { kind: 'inputs'; path: string }
  | { kind: 'steps'; stepId: string; path: string }
  | { kind: 'item' }
  | { kind: 'index' }
  | { kind: 'secret'; name: string }
);

/** Where a template sits in a cell: it decides which tokens are allowed there. */
export type TemplateSlot = 'script_args' | 'script_env' | 'http_url' | 'http_headers' | 'http_auth' | 'http_body' | 'text';

export type UntrustedSources = {
  /** Steps whose output is data the author did not write: an LLM cell, an http response, integration data. */
  stepIds: ReadonlySet<string>;
  /** True when the loop behind `{{item}}` iterates such data. */
  isItemUntrusted: boolean;
};

export type TemplateViolation = { code: 'secret_not_allowed_here' | 'untrusted_reference'; token: string; slot: TemplateSlot };

export type ResolutionScope = {
  inputs: Record<string, unknown>;
  /** The output fields of each step that ran, by step id. */
  steps: Record<string, Record<string, unknown>>;
  item?: unknown;
  index?: number;
  /** The value held for a secret name, undefined when none is stored. */
  secretValueOf: (name: string) => string | undefined;
};

export type Resolution = { text: string; secretNames: string[] };

const SLOTS_ACCEPTING_SECRETS: ReadonlySet<TemplateSlot> = new Set(['script_env', 'http_headers', 'http_auth']);
const SLOTS_REFUSING_UNTRUSTED: ReadonlySet<TemplateSlot> = new Set(['script_args', 'script_env', 'http_url', 'http_headers', 'http_auth']);

const TOKEN_PATTERN = /\{\{([^{}]*)\}\}/g;
const PATH = '[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*';
const INPUT_REFERENCE = new RegExp(`^inputs\\.(${PATH})$`);
const STEP_REFERENCE = new RegExp(`^steps\\.([A-Za-z0-9_-]+)\\.(${PATH})$`);
const SECRET_REFERENCE_PREFIX = 'secret:';

const tokenOf = (raw: string, start: number): TemplateToken => {
  const reference = raw.slice(2, -2).trim();
  if (reference === 'item') return { kind: 'item', raw, start };
  if (reference === 'index') return { kind: 'index', raw, start };
  if (reference.startsWith(SECRET_REFERENCE_PREFIX)) {
    const name = reference.slice(SECRET_REFERENCE_PREFIX.length);
    if (!SECRET_NAME.test(name)) throw new KernelError('invalid_secret_name', `"${name}" is not a secret name (letters, digits and underscores, not starting with a digit).`);
    return { kind: 'secret', name, raw, start };
  }
  const input = INPUT_REFERENCE.exec(reference);
  if (input) return { kind: 'inputs', path: input[1] ?? '', raw, start };
  const step = STEP_REFERENCE.exec(reference);
  if (step) return { kind: 'steps', stepId: step[1] ?? '', path: step[2] ?? '', raw, start };
  throw new KernelError('unknown_token', `${raw} is not a token: expected inputs.<path>, steps.<id>.<field>, item, index or secret:<NAME>.`);
};

const tokensOf = (template: string): TemplateToken[] => Array.from(template.matchAll(TOKEN_PATTERN), (match) => tokenOf(match[0], match.index));

const URL_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;
const END_OF_AUTHORITY = /[/?#]/;

/** The offset where the host part of a URL template ends: the userinfo, host and port, before the first `/`, `?` or `#`. */
const endOfAuthorityOf = (urlTemplate: string): number => {
  const authorityStart = URL_SCHEME_PREFIX.exec(urlTemplate)?.[0].length ?? 0;
  const relativeEnd = urlTemplate.slice(authorityStart).search(END_OF_AUTHORITY);
  return relativeEnd < 0 ? urlTemplate.length : authorityStart + relativeEnd;
};

const referencesUntrustedData = (token: TemplateToken, untrusted: UntrustedSources): boolean => {
  if (token.kind === 'steps') return untrusted.stepIds.has(token.stepId);
  return token.kind === 'item' && untrusted.isItemUntrusted;
};

type ViolationCheck = { template: string; slot: TemplateSlot; untrusted?: UntrustedSources };

/** Lists the tokens a template may not hold in its slot: a secret outside the slots that accept one, a reference to untrusted data where it could steer a command or a request. Throws unknown_token or invalid_secret_name for a malformed token. */
export const findTemplateViolations = ({ template, slot, untrusted }: ViolationCheck): TemplateViolation[] => {
  const isUrl = slot === 'http_url';
  const endOfAuthority = isUrl ? endOfAuthorityOf(template) : template.length;
  const untrustedIsRefused = SLOTS_REFUSING_UNTRUSTED.has(slot);

  return tokensOf(template).flatMap((token): TemplateViolation[] => {
    const isSecretOutOfPlace = token.kind === 'secret' && !SLOTS_ACCEPTING_SECRETS.has(slot);
    if (isSecretOutOfPlace) return [{ code: 'secret_not_allowed_here', token: token.raw, slot }];
    const isInSensitivePart = token.start < endOfAuthority;
    const isUntrustedWhereRefused = untrusted !== undefined && untrustedIsRefused && isInSensitivePart && referencesUntrustedData(token, untrusted);
    return isUntrustedWhereRefused ? [{ code: 'untrusted_reference', token: token.raw, slot }] : [];
  });
};

/** Throws a KernelError carrying the code of the first violation of the template in its slot. */
export const assertTemplateAllowed = (check: ViolationCheck): void => {
  const [firstViolation] = findTemplateViolations(check);
  if (!firstViolation) return;
  throw new KernelError(firstViolation.code, `${firstViolation.token} is not allowed in ${firstViolation.slot}.`);
};

const unresolved = (token: TemplateToken): KernelError => new KernelError('unresolved_reference', `${token.raw} refers to nothing: no such value in this run.`);

const textOf = (value: unknown, token: TemplateToken): string => {
  if (value === undefined || value === null) throw unresolved(token);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return canonicalJsonOf(value);
};

const valueOfToken = (token: TemplateToken, scope: ResolutionScope, usedSecretNames: Set<string>): string => {
  switch (token.kind) {
    case 'inputs':
      return textOf(valueAtDottedPath(scope.inputs, token.path), token);
    case 'steps':
      return textOf(valueAtDottedPath(scope.steps, `${token.stepId}.${token.path}`), token);
    case 'item':
      return textOf(scope.item, token);
    case 'index':
      return textOf(scope.index, token);
    case 'secret': {
      const value = scope.secretValueOf(token.name);
      if (!value) throw new KernelError('secret_missing', `the secret ${token.name} holds no value.`);
      usedSecretNames.add(token.name);
      return value;
    }
  }
};

/**
 * Replaces every token of `template` by its value, in one pass: a value that itself looks like a token is not expanded.
 * An object value is written as canonical JSON; a null or absent value is unresolved.
 * Returns the text and the names of the secrets it now holds, so the caller can mask them in every output.
 */
export const resolveTemplate = ({ template, scope }: { template: string; scope: ResolutionScope }): Resolution => {
  const tokens = tokensOf(template);
  const usedSecretNames = new Set<string>();
  let text = '';
  let copiedUpTo = 0;
  for (const token of tokens) {
    text += template.slice(copiedUpTo, token.start) + valueOfToken(token, scope, usedSecretNames);
    copiedUpTo = token.start + token.raw.length;
  }
  return { text: text + template.slice(copiedUpTo), secretNames: [...usedSecretNames] };
};
