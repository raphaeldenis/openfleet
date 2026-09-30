import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDirTracker } from './tempDirTracker.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EIGHT_HEX = /^[0-9a-f]{8}$/;
const MAX_LINE_CHARS = 8 * 1024;
const RING_CAPACITY = 2000;

type ParsedLine = Record<string, any>;

const tempDirs = createTempDirTracker();
let stdoutIsTtyBefore: PropertyDescriptor | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

async function loadLogger() {
  vi.resetModules();
  return import('./logger.js');
}

function setStdoutIsTty(isTty: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true });
}

function everyConsoleArgument(): unknown[] {
  return [logSpy, warnSpy, errorSpy].flatMap((spy) => spy.mock.calls.flat());
}

function writtenLines(): string[] {
  return everyConsoleArgument() as string[];
}

function onlyWrittenLine(): string {
  const lines = writtenLines();
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

function parsedLine(): ParsedLine {
  return JSON.parse(onlyWrittenLine()) as ParsedLine;
}

beforeEach(() => {
  stdoutIsTtyBefore = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  setStdoutIsTty(false);
  vi.stubEnv('OPENFLEET_LOG_LEVEL', '');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (stdoutIsTtyBefore) Object.defineProperty(process.stdout, 'isTTY', stdoutIsTtyBefore);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  tempDirs.removeAll();
});

describe('log — line format', () => {
  it('writes an info line as one NDJSON object to console.log with an ISO timestamp, the level and the message', async () => {
    const { log } = await loadLogger();

    log('info', 'daemon listening on http://127.0.0.1:7331');

    const line = parsedLine();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(line.ts).toMatch(ISO_TIMESTAMP);
    expect(line.level).toBe('info');
    expect(line.msg).toBe('daemon listening on http://127.0.0.1:7331');
    expect(line).not.toHaveProperty('id');
    expect(line).not.toHaveProperty('err');
  });

  it('writes a warn line to console.warn', async () => {
    const { log } = await loadLogger();

    log('warn', 'skipping an out-of-bounds row');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(parsedLine().level).toBe('warn');
  });

  it('writes an error line to console.error with the error as { name, message, stack, code }', async () => {
    const { log } = await loadLogger();
    const error = Object.assign(new Error('boom'), { code: 'EBOOM' });

    log('error', 'relaunch failed', error);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = parsedLine();
    expect(line.err).toEqual({ name: 'Error', message: 'boom', stack: expect.stringContaining('Error: boom'), code: 'EBOOM' });
  });

  it('carries id, sessionId, code and any other field next to the message, and a field never overrides ts, level or msg', async () => {
    const { log } = await loadLogger();

    log('warn', 'hook failed open', undefined, { id: 'abc12345', sessionId: 's-1', code: 'hook_fail_open', attempt: 3, ts: 'forged', level: 'info', msg: 'forged' });

    const line = parsedLine();
    expect(line).toMatchObject({ level: 'warn', msg: 'hook failed open', id: 'abc12345', sessionId: 's-1', code: 'hook_fail_open', attempt: 3 });
    expect(line.ts).toMatch(ISO_TIMESTAMP);
  });

  it('puts a non-error detail under detail', async () => {
    const { log } = await loadLogger();

    log('info', 'thing', { rows: 3 });

    expect(parsedLine().detail).toEqual({ rows: 3 });
  });

  it('strips control and bidi characters from the message so one call is one line', async () => {
    const { log } = await loadLogger();

    log('info', 'a\nb\r\u001b[31mc\u0000d‮e');

    expect(parsedLine().msg).toBe('ab[31mcde');
    expect(onlyWrittenLine()).not.toMatch(/\\u001b|\\u0000|\\u202e/);
  });

  it('gives an error line without an id a fresh 8-hex id, keeps a caller id, and mints none for info and warn', async () => {
    const { log, recentLogLines } = await loadLogger();

    log('error', 'no id');
    log('error', 'own id', undefined, { id: 'cafe0123' });
    log('warn', 'warn');

    const [minted, kept, warned] = recentLogLines().map((line) => JSON.parse(line) as ParsedLine);
    expect(minted!.id).toMatch(EIGHT_HEX);
    expect(kept!.id).toBe('cafe0123');
    expect(warned).not.toHaveProperty('id');
  });

  it('mints distinct ids for errors logged in the same millisecond', async () => {
    const { log } = await loadLogger();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T10:00:00.000Z'));

    for (let index = 0; index < 200; index += 1) log('error', 'same ms');
    vi.useRealTimers();

    const ids = writtenLines().map((line) => (JSON.parse(line) as ParsedLine).id as string);
    expect(new Set(ids).size).toBe(200);
  });
});

describe('log — levels', () => {
  it('drops debug lines unless OPENFLEET_LOG_LEVEL=debug, from stdout and from the ring buffer', async () => {
    const { log, recentLogLines } = await loadLogger();

    log('debug', 'per-request line');

    expect(writtenLines()).toEqual([]);
    expect(recentLogLines()).toEqual([]);
  });

  it('writes debug lines when OPENFLEET_LOG_LEVEL=debug', async () => {
    vi.stubEnv('OPENFLEET_LOG_LEVEL', 'debug');
    const { log } = await loadLogger();

    log('debug', 'per-request line');

    expect(parsedLine()).toMatchObject({ level: 'debug', msg: 'per-request line' });
  });
});

describe('log — TTY printer', () => {
  it('prints HH:MM:SS LEVEL msg  key=value on one line for an info line', async () => {
    setStdoutIsTty(true);
    const { log } = await loadLogger();

    log('info', 'session created', undefined, { sessionId: 's-1', count: 2 });

    expect(onlyWrittenLine()).toMatch(/^\d{2}:\d{2}:\d{2} INFO session created {2}sessionId=s-1 count=2$/);
  });

  it('prints the stack on the following lines for an error, and never prints an object', async () => {
    setStdoutIsTty(true);
    const { log } = await loadLogger();

    log('error', 'relaunch failed', new Error('boom'), { detailObject: { nested: 1 } });

    const printed = everyConsoleArgument();
    expect(printed.every((argument) => typeof argument === 'string')).toBe(true);
    const [firstLine, ...stackLines] = onlyWrittenLine().split('\n');
    expect(firstLine).toMatch(/^\d{2}:\d{2}:\d{2} ERROR relaunch failed {2}id=[0-9a-f]{8}/);
    expect(stackLines.join('\n')).toContain('Error: boom');
    expect(onlyWrittenLine()).not.toContain('[object Object]');
    expect(onlyWrittenLine().trimStart().startsWith('{')).toBe(false);
  });

  it('prints NDJSON when stdout is not a TTY', async () => {
    setStdoutIsTty(false);
    const { log } = await loadLogger();

    log('info', 'plain');

    expect(onlyWrittenLine().startsWith('{')).toBe(true);
  });
});

describe('log — redaction', () => {
  it('drops err.input, which the node:url TypeError fills with the full URL', async () => {
    const { log } = await loadLogger();
    const error = Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL', input: 'ws://127.0.0.1:7331/ws?ticket=TICKET-SECRET' });

    log('error', 'ws upgrade failed', error);

    expect(onlyWrittenLine()).not.toContain('TICKET-SECRET');
    expect(parsedLine().err).toMatchObject({ name: 'TypeError', code: 'ERR_INVALID_URL' });
    expect(parsedLine().err).not.toHaveProperty('input');
  });

  it.each(['Bearer abc123SECRET', 'bearer abc123SECRET', 'BEARER abc123SECRET', 'Bearer%20abc123SECRET', 'bearer%20abc123SECRET', 'Bearer: abc123SECRET', 'Bearer:abc123SECRET', 'Authorization: Bearer   abc123SECRET'])(
    'masks the bearer token in %s in the message, in an error message and in a detail string',
    async (text) => {
      const { log } = await loadLogger();

      log('error', `request with ${text} failed`, new Error(`upstream said ${text}`), { note: text });

      expect(onlyWrittenLine()).not.toContain('abc123SECRET');
      expect(onlyWrittenLine()).toContain('Bearer ***');
    },
  );

  it.each(['/hooks/tok123SECRET', 'http://127.0.0.1:7331/hooks/tok123SECRET/stop?x=1', '%2Fhooks%2Ftok123SECRET', '%2fhooks%2ftok123SECRET', '/hooks%2Ftok123SECRET', '%252Fhooks%252Ftok123SECRET'])(
    'masks the hook token in %s',
    async (text) => {
      const { log } = await loadLogger();

      log('warn', `hook call ${text} refused`, undefined, { url: text });

      expect(onlyWrittenLine()).not.toContain('tok123SECRET');
      expect(onlyWrittenLine()).toContain('/hooks/***');
    },
  );

  it('keeps the /hooks/:token route pattern, which is not a secret', async () => {
    const { log } = await loadLogger();

    log('error', 'POST /hooks/:token → 500');

    expect(parsedLine().msg).toBe('POST /hooks/:token → 500');
  });

  it('masks the value of any key matching token, secret, authorization or password, at any depth, in any case', async () => {
    const { log } = await loadLogger();

    log('info', 'config loaded', { adminToken: 'v1-VALUE', Authorization: 'v2-VALUE', nested: { db_password: 'v3-VALUE', list: [{ CLIENT_SECRET: 'v4-VALUE' }] } }, { hookToken: 'v5-VALUE' });

    const line = onlyWrittenLine();
    for (const value of ['v1-VALUE', 'v2-VALUE', 'v3-VALUE', 'v4-VALUE', 'v5-VALUE']) expect(line).not.toContain(value);
    expect(parsedLine().detail.adminToken).toBe('***');
    expect(parsedLine().hookToken).toBe('***');
  });

  it('unboxes boxed strings and redacts them', async () => {
    const { log } = await loadLogger();

    log('info', 'boxed', { note: new String('Bearer boxedSECRET') });

    expect(onlyWrittenLine()).not.toContain('boxedSECRET');
    expect(parsedLine().detail.note).toBe('Bearer ***');
  });

  it('shortens the OpenFleet home to $OPENFLEET_HOME and the user home to ~, and leaves other paths and look-alike prefixes alone', async () => {
    const openfleetHome = join(tempDirs.make('of-home-'), 'a.b(c)[d]+e');
    mkdirSync(openfleetHome);
    vi.stubEnv('OPENFLEET_HOME', openfleetHome);
    const { log } = await loadLogger();
    const user = homedir();

    log('warn', `token dir ${openfleetHome}/sessions/x and ${user}/Documents/Coding/x and ${user}extra and /opt/other`);

    expect(parsedLine().msg).toBe(`token dir $OPENFLEET_HOME/sessions/x and ~/Documents/Coding/x and ${user}extra and /opt/other`);
  });

  it('shortens the realpath spelling of the OpenFleet home too', async () => {
    const openfleetHome = tempDirs.make('of-home-');
    vi.stubEnv('OPENFLEET_HOME', openfleetHome);
    const { log } = await loadLogger();

    log('warn', `at ${realpathSync(openfleetHome)}/state and ${openfleetHome}/state`);

    expect(parsedLine().msg).toBe('at $OPENFLEET_HOME/state and $OPENFLEET_HOME/state');
  });

  it('shortens paths inside err.message, err.stack and detail values', async () => {
    const openfleetHome = tempDirs.make('of-home-');
    vi.stubEnv('OPENFLEET_HOME', openfleetHome);
    const { log } = await loadLogger();

    log('error', 'failed', Object.assign(new Error(`cannot read ${openfleetHome}/admin.token`), {}), { file: `${openfleetHome}/x` });

    expect(onlyWrittenLine()).not.toContain(openfleetHome);
    expect(parsedLine().file).toBe('$OPENFLEET_HOME/x');
  });
});

describe('log — ring buffer', () => {
  it('keeps the last 2000 lines, oldest first', async () => {
    const { log, recentLogLines } = await loadLogger();

    for (let index = 0; index < RING_CAPACITY + 500; index += 1) log('info', `line ${index}`);

    const lines = recentLogLines();
    expect(lines).toHaveLength(RING_CAPACITY);
    expect((JSON.parse(lines[0]!) as ParsedLine).msg).toBe('line 500');
    expect((JSON.parse(lines.at(-1)!) as ParsedLine).msg).toBe(`line ${RING_CAPACITY + 499}`);
  });

  it('stores the redacted line, not the raw input', async () => {
    const { log, recentLogLines } = await loadLogger();

    log('error', 'failed with Bearer ringSECRET', new Error('/hooks/ringSECRET'));

    expect(recentLogLines().join('\n')).not.toContain('ringSECRET');
  });

  it('returns a copy that callers cannot use to alter the buffer', async () => {
    const { log, recentLogLines } = await loadLogger();
    log('info', 'kept');

    recentLogLines().length = 0;

    expect(recentLogLines()).toHaveLength(1);
  });

  it('stores the NDJSON line even when stdout is a TTY', async () => {
    setStdoutIsTty(true);
    const { log, recentLogLines } = await loadLogger();

    log('info', 'tty line');

    expect((JSON.parse(recentLogLines()[0]!) as ParsedLine).msg).toBe('tty line');
  });
});

describe('log — hostile input (spec §12 hostile 1 and 3)', () => {
  it('caps and cleans an error whose message holds the admin bearer, a hook URL, an ANSI escape, a NUL and 50 KiB of text', async () => {
    const { log, recentLogLines } = await loadLogger();
    const hostile = `Bearer adminSECRET http://x/hooks/hookSECRET \u001b[31mred\u0000nul ${'x'.repeat(50 * 1024)}`;

    log('error', hostile, new Error(hostile));

    const line = onlyWrittenLine();
    expect(line.length).toBeLessThanOrEqual(MAX_LINE_CHARS + 64);
    expect(line).not.toMatch(/adminSECRET|hookSECRET|\\u001b|\\u0000|\u001b|\u0000/);
    expect(recentLogLines()[0]).toBe(line);
    expect(recentLogLines()[0]!.length).toBeLessThanOrEqual(MAX_LINE_CHARS + 64);
  });

  it('marks a capped line with the number of dropped characters', async () => {
    const { log } = await loadLogger();

    log('info', 'many fields', undefined, Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, 'v'.repeat(1000)])));

    expect(onlyWrittenLine()).toMatch(/\.\.\.\[truncated \d+ chars\]$/);
  });

  it('logs a thrown undefined without failing, and still mints an id', async () => {
    const { log } = await loadLogger();

    expect(() => log('error', 'caught', undefined)).not.toThrow();

    expect(parsedLine().id).toMatch(EIGHT_HEX);
  });

  it('logs a thrown string as a detail', async () => {
    const { log } = await loadLogger();

    log('error', 'caught', 'plain string thrown');

    expect(parsedLine().detail).toBe('plain string thrown');
  });

  it('logs an error whose cause is circular', async () => {
    const { log } = await loadLogger();
    const error = new Error('outer');
    const cause = new Error('inner') as Error & { cause?: unknown };
    cause.cause = error;
    (error as Error & { cause?: unknown }).cause = cause;

    expect(() => log('error', 'caught', error)).not.toThrow();

    expect(parsedLine().err.message).toBe('outer');
  });

  it('logs an error whose stack getter throws', async () => {
    const { log } = await loadLogger();
    const error = new Error('no stack');
    Object.defineProperty(error, 'stack', { get: () => { throw new Error('stack getter'); } });

    expect(() => log('error', 'caught', error)).not.toThrow();

    expect(parsedLine().err).toMatchObject({ name: 'Error', message: 'no stack' });
  });

  it('logs an error whose message getter throws', async () => {
    const { log } = await loadLogger();
    const error = new Error('x');
    Object.defineProperty(error, 'message', { get: () => { throw new Error('message getter'); } });

    expect(() => log('error', 'caught', error)).not.toThrow();

    expect(writtenLines()).toHaveLength(1);
  });

  it('never throws on circular objects, BigInt, symbols, functions, throwing proxies and throwing toJSON', async () => {
    const { log } = await loadLogger();
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    const throwingProxy = new Proxy({}, { ownKeys: () => { throw new Error('ownKeys'); }, get: () => { throw new Error('get'); }, getPrototypeOf: () => { throw new Error('proto'); } });
    const throwingToJson = { toJSON: () => { throw new Error('toJSON'); } };
    const throwingGetter = { get boom(): string { throw new Error('getter'); } };
    const hostileDetails: unknown[] = [circular, 10n, Symbol('s'), () => 1, throwingProxy, throwingToJson, throwingGetter, { big: 1n }, [circular], Object.create(null), new Date(Number.NaN)];

    for (const detail of hostileDetails) expect(() => log('error', 'hostile', detail, { field: detail })).not.toThrow();

    expect(writtenLines()).toHaveLength(hostileDetails.length);
  });

  it('never throws on a non-string message, a null-prototype fields object and a __proto__ key', async () => {
    const { log } = await loadLogger();
    const payload = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}') as Record<string, unknown>;

    expect(() => log('info', { not: 'a string' } as unknown as string, payload, payload)).not.toThrow();
    expect(() => log('nope' as 'info', 'unknown level')).not.toThrow();

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('swallows a console method that throws, as on EPIPE, and still fills the ring buffer', async () => {
    const { log, recentLogLines } = await loadLogger();
    errorSpy.mockImplementation(() => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); });

    expect(() => log('error', 'pipe closed')).not.toThrow();

    expect(recentLogLines()).toHaveLength(1);
  });
});

describe('log — gaps the first suite left open', () => {
  it('shortens the OpenFleet home to $OPENFLEET_HOME even when it lives under the user home', async () => {
    vi.stubEnv('OPENFLEET_HOME', join(homedir(), '.openfleet-qe-probe'));
    const { log } = await loadLogger();

    log('warn', `read ${join(homedir(), '.openfleet-qe-probe')}/admin.token and ${homedir()}/Documents/x`);

    expect(parsedLine().msg).toBe('read $OPENFLEET_HOME/admin.token and ~/Documents/x');
  });

  it('masks a secret used as an object key in a detail', async () => {
    const { log } = await loadLogger();

    log('info', 'keyed', { 'Bearer keySECRET': 1, 'GET /hooks/hookKeySECRET': 2 });

    expect(onlyWrittenLine()).not.toMatch(/keySECRET|hookKeySECRET/);
  });

  it('masks a bearer token and a hook token in every error of a cause chain', async () => {
    const { log } = await loadLogger();
    const root = new Error('root saw Bearer rootSECRET');
    const middle = new Error('middle saw /hooks/middleSECRET', { cause: root });
    const top = new Error('top', { cause: middle });

    log('error', 'chain', top);

    expect(onlyWrittenLine()).not.toMatch(/rootSECRET|middleSECRET/);
    expect(onlyWrittenLine()).toContain('root saw Bearer ***');
  });

  it('masks a token passed as the id field', async () => {
    const { log } = await loadLogger();

    log('error', 'odd id', undefined, { id: 'Bearer idSECRET' });

    expect(onlyWrittenLine()).not.toContain('idSECRET');
  });

  it('never lets a field replace the logged error or the minted id', async () => {
    const { log } = await loadLogger();

    log('error', 'forgery attempt', new Error('real'), { err: 'forged', id: 5 as unknown as string });

    const line = parsedLine();
    expect(line.err.message).toBe('real');
    expect(line.id).toMatch(EIGHT_HEX);
  });

  it('logs an unknown level as an info line on console.log', async () => {
    const { log } = await loadLogger();

    log('nope' as 'info', 'unknown level');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(parsedLine().level).toBe('info');
  });

  it('follows process.stdout.isTTY as it is at each call, not as it was at import', async () => {
    const { log } = await loadLogger();

    log('info', 'first');
    setStdoutIsTty(true);
    log('info', 'second');
    setStdoutIsTty(false);
    log('info', 'third');

    const [first, second, third] = writtenLines() as [string, string, string];
    expect(first.startsWith('{')).toBe(true);
    expect(second).toMatch(/^\d{2}:\d{2}:\d{2} INFO second$/);
    expect(third.startsWith('{')).toBe(true);
  });

  it('marks a circular structure instead of failing', async () => {
    const { log } = await loadLogger();
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    log('info', 'loop', circular);

    expect(parsedLine().detail).toEqual({ name: 'loop', self: '[circular]' });
  });

  it('keeps the first 50 items of an array and 50 keys of an object and says how many were left out', async () => {
    const { log } = await loadLogger();
    const manyKeys = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`key${index}`, index]));

    log('info', 'wide', { list: Array.from({ length: 200 }, (_, index) => index), manyKeys });

    const { list, manyKeys: keptKeys } = parsedLine().detail;
    expect(list).toHaveLength(51);
    expect(list.at(-1)).toBe('…150 more');
    expect(Object.keys(keptKeys)).toHaveLength(50);
  });

  it('replaces what is nested deeper than the depth limit', async () => {
    const { log } = await loadLogger();
    let nested: Record<string, unknown> = { leaf: 'deep' };
    for (let level = 0; level < 20; level += 1) nested = { child: nested };

    log('info', 'nested', nested);

    expect(onlyWrittenLine()).toContain('[depth]');
    expect(onlyWrittenLine()).not.toContain('deep');
  });

  it('cuts one string value to 5 KiB, so a line holding one whole string is still valid JSON under the 8 KiB line cap', async () => {
    const { log } = await loadLogger();

    log('info', 'x'.repeat(100_000));

    expect(parsedLine().msg).toBe(`${'x'.repeat(5 * 1024)}…`);
  });

  it('leaves a line of exactly 8 KiB whole and marks a line one character longer', async () => {
    const { log } = await loadLogger();
    const fullPad = 'x'.repeat(4000);
    log('info', 'measure', undefined, { first: fullPad, second: fullPad, rest: '' });
    const emptyRestLength = onlyWrittenLine().length;
    logSpy.mockClear();
    const paddedTo = (length: number) => ({ first: fullPad, second: fullPad, rest: 'x'.repeat(length - emptyRestLength) });

    log('info', 'measure', undefined, paddedTo(MAX_LINE_CHARS));
    log('info', 'measure', undefined, paddedTo(MAX_LINE_CHARS + 1));

    const [exact, oneOver] = writtenLines() as [string, string];
    expect(exact).toHaveLength(MAX_LINE_CHARS);
    expect(() => JSON.parse(exact)).not.toThrow();
    expect(oneOver).toMatch(/\.\.\.\[truncated 1 chars\]$/);
  });

  it('keeps a message that tries to forge a second NDJSON line on one line, inside its own string', async () => {
    const { log } = await loadLogger();

    log('info', 'x"}\n{"ts":"2020-01-01T00:00:00.000Z","level":"error","msg":"forged');

    expect(onlyWrittenLine().split('\n')).toHaveLength(1);
    expect(parsedLine().level).toBe('info');
  });

  it('keeps an ANSI-and-newline message on one uncoloured line in the TTY printer, and indents every stack line', async () => {
    setStdoutIsTty(true);
    const { log } = await loadLogger();
    const error = new Error('x');
    error.stack = 'Error: x\n10:00:00 ERROR forged\n\u001b[2Jat y';

    log('error', 'a\nFAKE 10:00:00 ERROR forged\u001b[31m', error);

    const [head, ...stackLines] = onlyWrittenLine().split('\n');
    expect(head).toMatch(/^\d{2}:\d{2}:\d{2} ERROR aFAKE 10:00:00 ERROR forged\[31m {2}id=[0-9a-f]{8}$/);
    expect(stackLines.every((line) => line.startsWith('    '))).toBe(true);
    expect(onlyWrittenLine()).not.toContain('\u001b');
  });

  describe.each([{ printer: 'NDJSON', isTty: false }, { printer: 'TTY', isTty: true }])('the $printer printer strips invisible characters', ({ isTty }) => {
    const INVISIBLE_CODE_POINTS = [
      0x2028, 0x2029, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x061c,
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
    ];
    const invisible = INVISIBLE_CODE_POINTS.map((codePoint) => String.fromCharCode(codePoint));
    const withInvisible = (word: string) => `${invisible.join('')}${word}${invisible.join('')}`;
    const LINE_BREAKS = /\n|\r|\p{Zl}|\p{Zp}/u;

    it('strips them from the message, from string values and from keys, so one call is one line', async () => {
      setStdoutIsTty(isTty);
      const { log } = await loadLogger();

      log('info', `a${withInvisible('msg')}b`, { [withInvisible('key')]: withInvisible('value') }, { field: withInvisible('field') });

      const line = onlyWrittenLine();
      expect(invisible.some((character) => line.includes(character))).toBe(false);
      expect(line.split(LINE_BREAKS)).toHaveLength(1);
      expect(line).toContain('amsgb');
      expect(line).toContain('key');
      expect(line).toContain('value');
    });

    it('strips them from an error message and stack, which the logger keeps multi-line', async () => {
      setStdoutIsTty(isTty);
      const { log, recentLogLines } = await loadLogger();
      const error = new Error(withInvisible('boom'));
      error.stack = `Error: ${withInvisible('boom')}\n    at ${withInvisible('site')}`;

      log('error', 'failed', error);

      expect(invisible.some((character) => onlyWrittenLine().includes(character))).toBe(false);
      expect(invisible.some((character) => recentLogLines()[0]!.includes(character))).toBe(false);
    });
  });

  it('strips the invisible characters from the ring buffer line and keeps it parseable as one line', async () => {
    const { log, recentLogLines } = await loadLogger();

    log('info', `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`);

    const [stored] = recentLogLines();
    expect(stored!.split(/\n|\r|\p{Zl}|\p{Zp}/u)).toHaveLength(1);
    expect((JSON.parse(stored!) as ParsedLine).msg).toBe('abc');
  });

  it.each([
    ['a Buffer', () => Buffer.from('Bearer bufSECRET'), '[Buffer 16 bytes]'],
    ['a Uint8Array', () => new Uint8Array([66, 101, 97]), '[Uint8Array 3 bytes]'],
    ['a Float64Array', () => new Float64Array(2), '[Float64Array 16 bytes]'],
    ['an ArrayBuffer', () => new ArrayBuffer(8), '[ArrayBuffer 8 bytes]'],
    ['a DataView', () => new DataView(new ArrayBuffer(4)), '[DataView 4 bytes]'],
    ['a Map', () => new Map<string, unknown>([['Bearer mapSECRET', 'mapSECRET'], ['b', 2]]), '[Map 2 entries]'],
    ['a Set', () => new Set(['setSECRET']), '[Set 1 entries]'],
  ])('summarises %s by kind and size and never dumps its content', async (_name, make, summary) => {
    const { log } = await loadLogger();

    log('error', 'binary and collections', make(), { field: make() });

    const line = parsedLine();
    expect(line.detail).toBe(summary);
    expect(line.field).toBe(summary);
    expect(onlyWrittenLine()).not.toMatch(/SECRET|"0":|"1":/);
  });

  it('does not lose a Buffer nested in an object or an array', async () => {
    const { log } = await loadLogger();

    log('info', 'nested', { body: Buffer.from('abc'), chunks: [new Uint8Array(2)] });

    expect(parsedLine().detail).toEqual({ body: '[Buffer 3 bytes]', chunks: ['[Uint8Array 2 bytes]'] });
  });

  it.each([
    ['a token query parameter', 'GET /ws?token=qSECRET&x=1'],
    ['a ticket query parameter', 'GET /ws?ticket=qSECRET'],
    ['an access_token query parameter', 'GET /cb?access_token=qSECRET&state=1'],
    ['a percent-encoded key', 'GET /cb?access%5Ftoken=qSECRET'],
    ['a secret hidden behind escapes', 'GET /login?next=%2Fx%3Ftoken%3DqSECRET'],
    ['a Basic credential behind Authorization', 'Authorization: Basic qSECRET:pw!'],
    ['a Basic credential behind Proxy-Authorization', 'Proxy-Authorization: Basic qSECRET:pw!'],
    ['a bare Basic credential', 'header Basic cXNlY3JldDpxU0VDUkVU=='],
    ['URL credentials', 'clone https://qSECRET:pw@example.com/repo.git failed'],
  ])('masks %s in the message, in an error message and in a string field', async (_name, text) => {
    const { log } = await loadLogger();

    log('error', text, new Error(text), { note: text });

    expect(onlyWrittenLine()).not.toMatch(/qSECRET|cXNlY3JldDpxU0VDUkVU|pw!/);
  });

  it('keeps the text around a masked secret, in the same words the error envelope keeps', async () => {
    const { log } = await loadLogger();

    log('warn', 'GET /ws?ticket=qSECRET&x=1 refused (Bearer tokSECRET) in [Bearer tokSECRET] and {Bearer tokSECRET}');

    expect(parsedLine().msg).toBe('GET /ws?ticket=***&x=1 refused (Bearer ***) in [Bearer ***] and {Bearer ***}');
  });

  it.each(['token', 'accessToken', 'access_token', 'hook_token', 'adminToken', 'ticket', 'wsTicket', 'secret', 'clientSecret', 'password', 'db_password', 'authorization', 'Authorization', 'cookie', 'Set-Cookie', 'api_key', 'apiKey', 'x-api-key'])(
    'masks the value under the key %s',
    async (key) => {
      const { log } = await loadLogger();

      log('info', 'keys', { [key]: 'keyVALUE' }, { [key]: 'keyVALUE' });

      expect(onlyWrittenLine()).not.toContain('keyVALUE');
    },
  );

  it.each(['tokens', 'contextTokens', 'inputTokens', 'outputTokens', 'maxTokens', 'totalTokens'])(
    'keeps the value under the usage counter %s',
    async (key) => {
      const { log } = await loadLogger();

      log('info', 'usage', { [key]: 1234 }, { [key]: 1234 });

      expect(parsedLine().detail[key]).toBe(1234);
      expect(parsedLine()[key]).toBe(1234);
    },
  );
});

describe('log — linear-time on adversarial input', () => {
  const SIZES = [64 * 1024, 128 * 1024, 256 * 1024, 1024 * 1024];
  const LIMIT_MS = 500;

  const stringInputs: Record<string, (size: number) => string> = {
    question: (size) => '?'.repeat(size),
    percent: (size) => '%'.repeat(size),
    slash: (size) => '/'.repeat(size),
    bearer: (size) => 'Bearer '.repeat(Math.ceil(size / 7)),
    bearerEscaped: (size) => 'Bearer%20'.repeat(Math.ceil(size / 9)),
    hooks: (size) => '/hooks/'.repeat(Math.ceil(size / 7)),
    hooksEscaped: (size) => '%2Fhooks%2F'.repeat(Math.ceil(size / 11)),
    hooksThenPercent: (size) => `/hooks/${'%'.repeat(size)}`,
    singleLongToken: (size) => `Bearer ${'a'.repeat(size)}`,
    whitespaceAfterBearer: (size) => `Bearer${' '.repeat(size)}`,
    colonsAfterBearer: (size) => `Bearer${':'.repeat(size)}`,
    controlCharacters: (size) => '\u0000‮\n'.repeat(Math.ceil(size / 3)),
  };

  const structuredInputs: Record<string, (size: number) => unknown> = {
    nestedObjects: (size) => {
      let head: Record<string, unknown> = { leaf: 'Bearer x' };
      for (let depth = 0; depth < size / 10; depth += 1) head = { child: head };
      return head;
    },
    nestedArrays: (size) => {
      let head: unknown[] = ['Bearer x'];
      for (let depth = 0; depth < size / 10; depth += 1) head = [head];
      return head;
    },
    arrayOfStrings: (size) => Array.from({ length: Math.ceil(size / 10) }, () => 'Bearer x/hooks/y'),
    longKeys: (size) => ({ [`token${'k'.repeat(size)}`]: 'v', [`${'k'.repeat(size)}password`]: 'v', [`${'a'.repeat(size)}`]: 'Bearer x' }),
    manyKeys: (size) => Object.fromEntries(Array.from({ length: Math.ceil(size / 10) }, (_, index) => [`key${index}`, 'Bearer x'])),
    boxedLongString: (size) => new String('Bearer '.repeat(Math.ceil(size / 7))),
  };

  async function timeLogCall(call: (log: (level: 'error', message: string, detail?: unknown, fields?: Record<string, unknown>) => void) => void): Promise<number> {
    const { log } = await loadLogger();
    const start = performance.now();
    call(log);
    return performance.now() - start;
  }

  async function bestOfThree(call: Parameters<typeof timeLogCall>[0]): Promise<number> {
    const timings = [await timeLogCall(call), await timeLogCall(call), await timeLogCall(call)];
    return Math.min(...timings);
  }

  async function expectLinearGrowth(makeCall: (size: number) => Parameters<typeof timeLogCall>[0]): Promise<void> {
    const timings: number[] = [];
    for (const size of SIZES) timings.push(await bestOfThree(makeCall(size)));
    for (const timing of timings) expect(timing).toBeLessThan(LIMIT_MS);
    const [smallest, , , largest] = timings as [number, number, number, number];
    expect(largest).toBeLessThan(smallest * 32 + 50);
  }

  it.each(Object.keys(stringInputs))('handles %s as a message, an error message and a detail string in under 500 ms with no super-linear growth', async (name) => {
    const make = stringInputs[name]!;
    await expectLinearGrowth((size) => {
      const text = make(size);
      return (log) => log('error', text, new Error(text), { text });
    });
  });

  it.each(Object.keys(structuredInputs))('handles %s as a detail and as fields in under 500 ms with no super-linear growth', async (name) => {
    const make = structuredInputs[name]!;
    await expectLinearGrowth((size) => {
      const value = make(size);
      return (log) => log('error', 'structured', value, { value });
    });
  });

  it('keeps the ring buffer memory bounded after 1 MiB messages', async () => {
    const { log, recentLogLines } = await loadLogger();

    for (let index = 0; index < 50; index += 1) log('info', 'x'.repeat(1024 * 1024));

    expect(recentLogLines().every((line) => line.length <= MAX_LINE_CHARS + 64)).toBe(true);
  });
});
