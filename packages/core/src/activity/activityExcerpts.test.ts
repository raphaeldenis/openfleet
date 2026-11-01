import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { argumentsExcerpt, keptTokenOrMark, resultExcerpt } from './activityExcerpts.js';

// Built at run time: no token-shaped literal sits in the source.
const fakeSecret = (label: string) => `${label}-${randomBytes(8).toString('hex')}7`;
const fingerprintOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8);
const parsedArguments = (args: unknown) => JSON.parse(argumentsExcerpt(args)) as Record<string, unknown>;

describe('the arguments kept in the activity log', () => {
  it('keeps a UUID, a ticket, a status, a number and a boolean as they were given', () => {
    const sessionId = randomUUID();

    const kept = parsedArguments({ session_id: sessionId, ticket: 'ACT-3', status: 'in_progress', model: 'opus', count: 3, done: false, nothing: null });

    expect(kept).toEqual({ session_id: sessionId, ticket: 'ACT-3', status: 'in_progress', model: 'opus', count: 3, done: false, nothing: null });
  });

  it('keeps an identifier under a key that names one, in an array and in a nested object', () => {
    const kept = parsedArguments({ note_ids: ['n-1', 'n-2'], updates: [{ row_id: 'row:42', expected_rev: 2 }] });

    expect(kept).toEqual({ note_ids: ['n-1', 'n-2'], updates: [{ row_id: 'row:42', expected_rev: 2 }] });
  });

  it('stands a free text as its length and the first eight hex of its sha256, never its content', () => {
    const body = `curl -u user:${fakeSecret('probe')} https://example.test`;

    const kept = parsedArguments({ title: 'Plan', body_md: body });

    expect(kept).toEqual({ title: '[text len=4]', body_md: `[text len=${body.length} sha=${fingerprintOf(body)}]` });
  });

  it('gives no fingerprint for a text under 24 characters, which a dictionary could confirm', () => {
    const [shortText, longText] = ['p'.repeat(23), 'p'.repeat(24)];

    const kept = parsedArguments({ title: shortText, comment: longText, values: { [`${shortText}!`]: 1 } });

    expect(kept).toEqual({ title: '[text len=23]', comment: `[text len=24 sha=${fingerprintOf(longText)}]`, values: { [`[key len=24 sha=${fingerprintOf(`${shortText}!`)}]`]: '[secret]' } });
    expect(argumentsExcerpt({ values: { 'Due date': 1 } })).toBe('{"values":{"[key len=8]":"[secret]"}}');
  });

  it('stands an identifier-shaped text as its mark when its key names no identifier', () => {
    const secret = fakeSecret('probe');

    expect(argumentsExcerpt({ title: secret, nested: { note: { value: secret } } })).not.toContain(secret);
  });

  it('stands a value longer than 64 characters as its mark, even under an identifier key', () => {
    const longIdentifier = `id-${'a'.repeat(62)}`;

    expect(parsedArguments({ row_id: longIdentifier }).row_id).toBe(`[text len=65 sha=${fingerprintOf(longIdentifier)}]`);
  });

  it.each(['token', 'apiKey', 'client_secret', 'password', 'passwd', 'authorization', 'credentials', 'bearer', 'cookie', 'session', 'idempotency_key', 'pin'])(
    'hides whatever the key %s holds, a number or an identifier included',
    (key) => {
      const kept = parsedArguments({ [key]: { ticket: 'ACT-3', count: 1234 }, [`${key}s`]: 1234, flat: { [key]: 'ACT-3' } });

      expect(JSON.stringify(kept)).not.toMatch(/ACT-3|1234/);
    },
  );

  it('stands a key that is not made of letters and underscores as its mark', () => {
    const secret = fakeSecret('key');

    const excerpt = argumentsExcerpt({ values: { [secret]: 1, 'Due date': true } });

    expect(excerpt).not.toContain(secret);
    expect(excerpt).not.toContain('Due date');
  });

  it('cuts a structure deeper than four levels and an array or an object past 64 items', () => {
    const deep = { a: { b: { c: { d: { e: 'deep' } } } } };
    const wide = { ids: Array.from({ length: 70 }, (_, index) => `id-${index}`) };

    expect(parsedArguments(deep)).toEqual({ a: { b: { c: { d: '[cut]' } } } });
    expect(parsedArguments(wide).ids).toEqual([...Array.from({ length: 64 }, (_, index) => `id-${index}`), '[cut]']);
  });

  it('stands a credential the masker recognises as the secret mark, even shaped as an identifier', () => {
    const credential = ['s', 'k-'].join('') + 'a1'.repeat(12);

    expect(argumentsExcerpt({ row_id: credential })).not.toContain(credential);
  });
});

describe('arguments made of shell-significant text, generated at random', () => {
  const SHELL_SIGNIFICANT = ' \t$`()\'";\\|&<>{}*?!#~=';
  const ALPHABET = `${SHELL_SIGNIFICANT}abcXYZ019._:/-`;
  const SAFE_KEPT_STRING = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
  const KEYS = ['title', 'status', 'ticket', 'row_id', 'note', 'command', 'args'];

  const seededRandom = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const random = seededRandom(20261101);
  const randomText = () => {
    const length = 8 + Math.floor(random() * 120);
    const characters = Array.from({ length }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]!);
    characters[Math.floor(random() * length)] = SHELL_SIGNIFICANT[Math.floor(random() * SHELL_SIGNIFICANT.length)]!;
    return characters.join('');
  };
  const stringLeavesOf = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (value === null || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, entry]) => [key, ...stringLeavesOf(entry)]);
  };
  const isMark = (text: string) => /^\[(text|key) len=\d+(?: sha=[0-9a-f]{8})?\]$|^\[(cut|secret)\]$/.test(text);

  it('never lets one of 200 texts out as it was given, and keeps only marks or short safe strings', () => {
    const texts = Array.from({ length: 200 }, randomText);

    for (const [index, text] of texts.entries()) {
      const key = KEYS[index % KEYS.length]!;
      const excerpt = argumentsExcerpt({ [key]: text, list: [text], nested: { [key]: text } });

      expect(excerpt).not.toContain(text);
      expect(excerpt).not.toContain(JSON.stringify(text).slice(1, -1));
      expect(stringLeavesOf(JSON.parse(excerpt)).every((leaf) => isMark(leaf) || SAFE_KEPT_STRING.test(leaf))).toBe(true);
    }
  });
});

describe('the result kept in the activity log', () => {
  it('keeps the size and the scalar fields that pass the list, never a free text', () => {
    const noteId = randomUUID();
    const body = `--token ${fakeSecret('result')}`;
    const resultText = JSON.stringify({ id: noteId, status: 'open', title: 'Plan', body_md: body, rev: 1 });

    expect(resultExcerpt(resultText)).toBe(`[result len=${resultText.length}] {"id":"${noteId}","status":"open","rev":1}`);
  });

  it('keeps only the size of a text that is not a JSON object', () => {
    const errorText = `error note_not_found: no note --password ${fakeSecret('error')}`;

    expect(resultExcerpt(errorText)).toBe(`[result len=${errorText.length}]`);
    expect(resultExcerpt('[1,2]')).toBe('[result len=5]');
  });
});

describe('a token kept as the detail or the entity id', () => {
  it('keeps an error code, a class name, a version and an identifier', () => {
    expect(['note_not_found', 'TypeError', '0.15.0', 'no-such-proposal'].map(keptTokenOrMark)).toEqual(['note_not_found', 'TypeError', '0.15.0', 'no-such-proposal']);
  });

  it('stands any other text as its mark', () => {
    const message = `boom --password ${fakeSecret('detail')}`;

    expect(keptTokenOrMark(message)).toBe(`[text len=${message.length} sha=${fingerprintOf(message)}]`);
  });
});
