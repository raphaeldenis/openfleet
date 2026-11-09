import { getEventListeners } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { sendHttpStep, type HttpStepNetwork, type HttpStepRequest } from './httpStepRequest.js';

const LOOPBACK = '127.0.0.1';
type Answers = { address: string; family: 4 | 6 }[];

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

const listenCountingConnections = async () => {
  const connections = { opened: 0 };
  server = createServer((_request, response) => response.end('reached'));
  server.on('connection', () => { connections.opened += 1; });
  await new Promise<void>((resolve) => server!.listen(0, LOOPBACK, resolve));
  return { connections, port: (server.address() as { port: number }).port };
};

/** A clock whose timers fire only when the test calls `fireAll`. */
const createHandClock = () => {
  const armed = new Set<() => void>();
  const startTimer: NonNullable<HttpStepNetwork['startTimer']> = (onElapsed) => { armed.add(onElapsed); return () => { armed.delete(onElapsed); }; };
  return { startTimer, armedCount: () => armed.size, fireAll: () => [...armed].forEach((onElapsed) => { armed.delete(onElapsed); onElapsed(); }) };
};

const createHeldResolver = () => {
  let lookups = 0;
  let release!: (answers: Answers) => void;
  const resolveAddresses: HttpStepNetwork['resolveAddresses'] = () => { lookups += 1; return new Promise<Answers>((resolve) => { release = resolve; }); };
  return { resolveAddresses, release: (answers: Answers) => release(answers), lookupCount: () => lookups };
};

const requestTo = (port: number, signal: AbortSignal): HttpStepRequest => ({
  url: new URL(`http://held.test:${port}/`), method: 'GET', headers: {}, allowedHosts: ['held.test'], timeoutMs: 1000, maxRetainedChars: 100, signal,
});
const abortListenersOf = (signal: AbortSignal) => getEventListeners(signal, 'abort').length;
const flushEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('sendHttpStep while the name is being resolved', () => {
  it('answers timeout when the deadline elapses during the resolution, and drops its abort listener', async () => {
    const clock = createHandClock();
    const resolver = createHeldResolver();
    const controller = new AbortController();
    const pending = sendHttpStep(requestTo(1, controller.signal), { ...resolver, isForbiddenAddress: () => false, startTimer: clock.startTimer });
    expect(abortListenersOf(controller.signal)).toBe(1);

    clock.fireAll();

    expect(await pending).toEqual({ kind: 'timeout' });
    expect(abortListenersOf(controller.signal)).toBe(0);
  });

  it('answers aborted when the signal aborts during the resolution, cancels its timer and drops its abort listener', async () => {
    const clock = createHandClock();
    const resolver = createHeldResolver();
    const controller = new AbortController();
    const pending = sendHttpStep(requestTo(1, controller.signal), { ...resolver, isForbiddenAddress: () => false, startTimer: clock.startTimer });

    controller.abort();

    expect(await pending).toEqual({ kind: 'aborted' });
    expect(clock.armedCount()).toBe(0);
    expect(abortListenersOf(controller.signal)).toBe(0);
  });

  it('answers aborted for a signal already aborted, without asking the resolver or arming a timer', async () => {
    const clock = createHandClock();
    const resolver = createHeldResolver();
    const controller = new AbortController();
    controller.abort();

    const outcome = await sendHttpStep(requestTo(1, controller.signal), { ...resolver, isForbiddenAddress: () => false, startTimer: clock.startTimer });

    expect(outcome).toEqual({ kind: 'aborted' });
    expect(resolver.lookupCount()).toBe(0);
    expect(clock.armedCount()).toBe(0);
    expect(abortListenersOf(controller.signal)).toBe(0);
  });

  it('opens no connection and leaks no listener when the resolver answers after the abort', async () => {
    const { connections, port } = await listenCountingConnections();
    const clock = createHandClock();
    const resolver = createHeldResolver();
    const controller = new AbortController();
    const pending = sendHttpStep(requestTo(port, controller.signal), { ...resolver, isForbiddenAddress: () => false, startTimer: clock.startTimer });
    controller.abort();
    await pending;

    resolver.release([{ address: LOOPBACK, family: 4 }]);
    await flushEventLoop();
    await flushEventLoop();

    expect(connections.opened).toBe(0);
    expect(abortListenersOf(controller.signal)).toBe(0);
  });

  it('opens no connection when the resolver answers after the deadline', async () => {
    const { connections, port } = await listenCountingConnections();
    const clock = createHandClock();
    const resolver = createHeldResolver();
    const controller = new AbortController();
    const pending = sendHttpStep(requestTo(port, controller.signal), { ...resolver, isForbiddenAddress: () => false, startTimer: clock.startTimer });
    clock.fireAll();
    await pending;

    resolver.release([{ address: LOOPBACK, family: 4 }]);
    await flushEventLoop();
    await flushEventLoop();

    expect(connections.opened).toBe(0);
    expect(abortListenersOf(controller.signal)).toBe(0);
  });

  it('answers failed, without the text of the error, when the resolver rejects', async () => {
    const clock = createHandClock();
    const rejecting: HttpStepNetwork = { resolveAddresses: async () => { throw new Error('ENOTFOUND secret-looking-host'); }, isForbiddenAddress: () => false, startTimer: clock.startTimer };
    const controller = new AbortController();

    const outcome = await sendHttpStep(requestTo(1, controller.signal), rejecting);

    expect(outcome).toEqual({ kind: 'failed' });
    expect(clock.armedCount()).toBe(0);
    expect(abortListenersOf(controller.signal)).toBe(0);
  });
});
