import { INTEGRATION_TOKEN_SECRET_NAME, OpenFleetError, type SecretScope, type SecretStatusAnswer } from '@openfleet/shared';
import { tokenAloneOf } from '../integrations/credentialEchoMasker.js';
import { MIN_SECRET_LENGTH } from '../playbooks/kernel/secretMasker.js';
import type { SecretRef, SecretRefRepository } from './secretRefRepository.js';
import type { SecretStore } from './secretStore.js';

const lengthInCharacters = (text: string): number => Array.from(text).length;

const answerOf = (scope: SecretScope, { name, status }: SecretRef): SecretStatusAnswer => ({ scopeKind: scope.kind, scopeId: scope.id, name, status });

/**
 * Sets, clears and resolves the secrets a scope declares. The metadata (declared names, stored or missing) is in SQLite; the values are in the SecretStore and nowhere else.
 * A scope is known when a name is declared under it; a name is known when its scope declares it.
 */
export class SecretService {
  constructor(private readonly deps: { refs: SecretRefRepository; store: SecretStore; clock: () => number }) {}

  statusOf(scope: SecretScope, name: string): SecretStatusAnswer {
    return answerOf(scope, this.declared(scope, name));
  }

  statusesOf(scope: SecretScope): SecretStatusAnswer[] {
    if (!this.deps.refs.isScopeKnown(scope)) throw new OpenFleetError('secret_scope_not_found', 'no secret is declared under this scope.');
    return this.deps.refs.listOf(scope).map((ref) => answerOf(scope, ref));
  }

  /** Stores the value in the secret store, then marks the name stored; a store that fails leaves the name as it was. The token of an `email:token` connection credential has at least the minimum length too, as the masker of provider echoes ignores a shorter one. */
  async set(scope: SecretScope, name: string, value: string, { by }: { by: string }): Promise<SecretStatusAnswer> {
    this.declared(scope, name);
    const isConnectionToken = scope.kind === 'connection' && name === INTEGRATION_TOKEN_SECRET_NAME;
    const tokenHalf = isConnectionToken ? tokenAloneOf(value) : undefined;
    const isTokenHalfTooShortToMask = tokenHalf !== undefined && lengthInCharacters(tokenHalf) < MIN_SECRET_LENGTH;
    const isTooShortToMask = lengthInCharacters(value) < MIN_SECRET_LENGTH || isTokenHalfTooShortToMask;
    if (isTooShortToMask) throw new OpenFleetError('secret_too_short', `a secret value has at least ${MIN_SECRET_LENGTH} characters.`);
    await this.deps.store.set(scope, name, value);
    this.deps.refs.markStored(scope, name, { at: new Date(this.deps.clock()).toISOString(), by });
    return this.statusOf(scope, name);
  }

  /** Removes the value, then marks the name missing; clearing a name that holds no value succeeds. */
  async clear(scope: SecretScope, name: string): Promise<SecretStatusAnswer> {
    this.declared(scope, name);
    await this.deps.store.clear(scope, name);
    this.deps.refs.markMissing(scope, name);
    return this.statusOf(scope, name);
  }

  /** Reads the value from the secret store for the caller that runs with it; nothing is kept here. Throws secret_not_connected_on_this_device when this device holds no value. */
  async resolve(scope: SecretScope, name: string): Promise<string> {
    this.declared(scope, name);
    return this.deps.store.read(scope, name);
  }

  private declared(scope: SecretScope, name: string): SecretRef {
    if (!this.deps.refs.isScopeKnown(scope)) throw new OpenFleetError('secret_scope_not_found', 'no secret is declared under this scope.');
    const ref = this.deps.refs.find(scope, name);
    if (ref === undefined) throw new OpenFleetError('secret_not_declared', 'this scope declares no secret of that name.');
    return ref;
  }
}
