import type { IncomingMessage } from 'node:http';
import * as z from 'zod';
import { OpenFleetError } from '@openfleet/shared';
import { DeliveredAnswerSchema, type SecretExchange } from '../secrets/parentBridgeSecretStore.js';
import { json, type Router } from './router.js';

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const isLoopbackAddress = (address: string | undefined): boolean => address !== undefined && LOOPBACK_ADDRESSES.has(address);

const refusal = () => new OpenFleetError('secret_nonce_invalid', 'the nonce is missing, spent, expired or unknown.');

/**
 * The internal routes answer the desktop app only: a request from a loopback address, with no Origin header (a browser page always sends one for a cross-origin request)
 * and no Authorization header (an admin or MCP token opens nothing here). Every refusal reads the same, so a caller learns nothing about why.
 */
export const refuseUnlessFromTheDesktopApp = (req: IncomingMessage): void => {
  const isFromLoopback = isLoopbackAddress(req.socket.remoteAddress);
  const carriesBrowserOrigin = req.headers.origin !== undefined;
  const carriesToken = req.headers.authorization !== undefined;
  if (!isFromLoopback || carriesBrowserOrigin || carriesToken) throw refusal();
};

const TakeBodySchema = z.object({ nonce: z.string().min(1) }).strict();
const DeliverEnvelopeSchema = z.object({ nonce: z.string().min(1) }).passthrough();

/**
 * `POST /internal/secrets/take {nonce}` answers `{value}` once, for the take nonce of a set in flight.
 * `POST /internal/secrets/deliver {nonce, outcome, value?}` settles the request that holds the deliver nonce, once. A nonce lives 30 seconds.
 * The protocol is outside /api on purpose: the authority here is a nonce the daemon printed to the app that spawned it, not the admin token.
 */
export function registerInternalSecretRoutes(router: Router, deps: { exchange: SecretExchange }): void {
  router.add('POST', '/internal/secrets/take', ({ req, res, body }) => {
    refuseUnlessFromTheDesktopApp(req);
    const { nonce } = TakeBodySchema.parse(body);
    const value = deps.exchange.take(nonce);
    if (value === undefined) throw refusal();
    json(res, 200, { value });
  });

  router.add('POST', '/internal/secrets/deliver', ({ req, res, body }) => {
    refuseUnlessFromTheDesktopApp(req);
    const { nonce, ...answer } = DeliverEnvelopeSchema.parse(body);
    const wasAccepted = deps.exchange.deliver(nonce, DeliveredAnswerSchema.parse(answer));
    if (!wasAccepted) throw refusal();
    json(res, 200, { ok: true });
  });
}
