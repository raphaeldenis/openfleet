import type { IncomingMessage, ServerResponse } from 'node:http';
import { newId } from '../ids.js';
import { log } from '../logger.js';

export type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; body: unknown }) => Promise<void> | void;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, pattern, keys, handler });
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      return { handler: route.handler, params };
    }
    return undefined;
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// The query string can carry secrets (tokens, admin credentials); never logged. Headers (bearer tokens,
// hook tokens) are never passed in either — only method, path and the error's own stack.
export function requestPath(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0] || '/';
}

export function logServerError(req: IncomingMessage, error: unknown): void {
  log('error', `${req.method ?? 'GET'} ${requestPath(req)} → 500 [${newId()}]`, error);
}

export const MAX_BODY_BYTES = 1024 * 1024;

export class PayloadTooLargeError extends Error {}

export class InvalidJsonBodyError extends Error {}

export async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of req) {
    bytesRead += (chunk as Buffer).length;
    if (bytesRead > maxBytes) throw new PayloadTooLargeError(`body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InvalidJsonBodyError((error as Error).message);
  }
}
