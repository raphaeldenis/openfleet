import type { IncomingMessage } from 'node:http';
import * as z from 'zod';
import { OPERATOR_NONCE_HEADER, OpenFleetError, SECRET_SCOPE_KINDS, SetSecretBodySchema, type SecretScope } from '@openfleet/shared';
import { SECRET_NAME } from '../playbooks/kernel/secretName.js';
import type { NonceLedger } from '../secrets/nonceLedger.js';
import type { SecretService } from '../secrets/secretService.js';
import { json, type Router } from './router.js';

const SecretPathSchema = z.object({
  scopeKind: z.enum(SECRET_SCOPE_KINDS),
  scopeId: z.string().min(1).max(128),
  name: z.string().regex(SECRET_NAME).max(128),
});

const REST_ACTOR_LABEL = 'admin';

const secretOfPath = (params: Record<string, string>): { scope: SecretScope; name: string } => {
  const { scopeKind, scopeId, name } = SecretPathSchema.parse(params);
  return { scope: { kind: scopeKind, id: scopeId }, name };
};

const requireOperatorNonce = (req: IncomingMessage, ledger: Pick<NonceLedger, 'redeem'>): void => {
  const nonce = req.headers[OPERATOR_NONCE_HEADER];
  const isLiveNonce = typeof nonce === 'string' && ledger.redeem(nonce, 'operator');
  if (!isLiveNonce) throw new OpenFleetError('secret_nonce_invalid', 'a set or a clear needs a live operator nonce from the desktop app.', { hint: 'set or clear the secret from the OpenFleet desktop app.' });
};

/**
 * The secrets of playbooks, connections and triggers, under /api behind the admin token. The value is in the JSON body of the set and nowhere else; no answer ever carries it.
 * A set and a clear also need the single-use operator nonce that a desktop command minted (header x-openfleet-operator-nonce): the admin token alone, which a process of the user can read, does not suffice.
 * A clear is idempotent. A status read needs the admin token only.
 */
export function registerSecretRoutes(router: Router, deps: { secrets: Pick<SecretService, 'statusOf' | 'set' | 'clear'>; nonces: Pick<NonceLedger, 'redeem'> }): void {
  router.add('GET', '/api/secrets/:scopeKind/:scopeId/:name', ({ res, params }) => {
    const { scope, name } = secretOfPath(params);
    json(res, 200, deps.secrets.statusOf(scope, name));
  });

  router.add('PUT', '/api/secrets/:scopeKind/:scopeId/:name', async ({ req, res, params, body }) => {
    requireOperatorNonce(req, deps.nonces);
    const { scope, name } = secretOfPath(params);
    const { value } = SetSecretBodySchema.parse(body);
    json(res, 200, await deps.secrets.set(scope, name, value, { by: REST_ACTOR_LABEL }));
  });

  router.add('DELETE', '/api/secrets/:scopeKind/:scopeId/:name', async ({ req, res, params }) => {
    requireOperatorNonce(req, deps.nonces);
    const { scope, name } = secretOfPath(params);
    json(res, 200, await deps.secrets.clear(scope, name));
  });
}
