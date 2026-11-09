import type { PlaybookCell } from '@openfleet/shared';
import { KernelError } from './kernel/kernelError.js';
import {
  assertResolvedHeadersAreSafe, assertTemplateAllowed, resolveHttpUrl, resolveTemplate,
  type ResolutionScope, type TemplateSlot, type UntrustedSources,
} from './kernel/tokenResolver.js';

type HttpCell = Extract<PlaybookCell, { kind: 'http' }>;

export type ResolvedHttpRequest = { url: URL; headers: Record<string, string>; body: string | undefined };

export const MAX_RESOLVED_HEADER_CHARS = 16 * 1024;

/** Headers the client sets itself: a cell that names one could point the request at another virtual host or break the framing. */
const HEADERS_OWNED_BY_THE_CLIENT: ReadonlySet<string> = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'expect']);

const basicCredentials = (username: string, password: string): string => `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;

/**
 * The url, headers and body of an http cell with their tokens resolved. Every token is checked in its place again here, so a flow stored outside the save path
 * is held to the same rules: no secret in the url or the body, no step output in the authority of the url, in a header or in the authentication.
 * The url is the one the client will parse (see resolveHttpUrl). Throws KernelError: header_injection, http_header_refused, http_headers_too_large, or the refusals of the token rules.
 */
export function resolveHttpRequest(cell: HttpCell, scope: ResolutionScope, untrusted: UntrustedSources): ResolvedHttpRequest {
  const resolveIn = (template: string, slot: TemplateSlot): string => {
    assertTemplateAllowed({ template, slot, untrusted });
    return resolveTemplate({ template, scope }).text;
  };

  const url = new URL(resolveHttpUrl({ template: cell.url, scope, untrusted }));
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(cell.headers ?? {})) headers[name.toLowerCase()] = resolveIn(template, 'http_headers');
  if (cell.auth?.type === 'bearer') headers['authorization'] = `Bearer ${resolveIn(cell.auth.token, 'http_auth')}`;
  if (cell.auth?.type === 'basic') headers['authorization'] = basicCredentials(resolveIn(cell.auth.username, 'http_auth'), resolveIn(cell.auth.password, 'http_auth'));

  assertResolvedHeadersAreSafe(headers);
  const ownedHeader = Object.keys(headers).find((name) => HEADERS_OWNED_BY_THE_CLIENT.has(name));
  if (ownedHeader !== undefined) throw new KernelError('http_header_refused', `the header ${ownedHeader} is set by the client and cannot be written in a cell.`);
  const headerChars = Object.entries(headers).reduce((total, [name, value]) => total + name.length + value.length, 0);
  if (headerChars > MAX_RESOLVED_HEADER_CHARS) throw new KernelError('http_headers_too_large', `the resolved headers hold more than ${MAX_RESOLVED_HEADER_CHARS} characters.`);

  const body = cell.body === undefined ? undefined : resolveIn(cell.body, 'http_body');
  return { url, headers, body };
}
