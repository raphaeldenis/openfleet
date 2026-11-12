import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest { method: string; path: string; headers: IncomingHttpHeaders }

export interface ScriptedAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** The server accepts the request and never answers. */
  isSilent?: boolean;
}

const OK_WITH_NOTHING: ScriptedAnswer = { status: 200, body: '{}' };

/** A server on 127.0.0.1 standing in for a provider: it answers what the test scripts and remembers every request it received. */
export const startFakeHttpServer = async () => {
  const seen: SeenRequest[] = [];
  let nextAnswer: (request: SeenRequest) => ScriptedAnswer = () => OK_WITH_NOTHING;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const request: SeenRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers };
    seen.push(request);
    const answer = nextAnswer(request);
    if (answer.isSilent === true) return;
    res.writeHead(answer.status, answer.headers ?? {});
    res.end(answer.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    seen,
    answerWith: (answer: ScriptedAnswer | ((request: SeenRequest) => ScriptedAnswer)) => { nextAnswer = typeof answer === 'function' ? answer : () => answer; },
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
};

export type FakeHttpServer = Awaited<ReturnType<typeof startFakeHttpServer>>;
