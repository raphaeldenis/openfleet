import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { argumentsExcerpt, keptDetail, keptIdentifier, keptLabel, resultExcerpt } from './activityExcerpts.js';
import { ParameterVocabulary } from './activityVocabulary.js';

// Built at run time: no token-shaped literal sits in the source.
const fakeSecret = (label: string) => `${label}-${randomBytes(8).toString('hex')}7`;
const fakeLetterSecret = () => `probe${randomBytes(8).toString('hex').replace(/[0-9]/g, 'q')}`;

const vocabularyOfTestTools = () => {
  const vocabulary = new ParameterVocabulary();
  vocabulary.learnToolSchema('a_test_tool', {
    session_id: z.string(), title: z.string(), body_md: z.string(), comment: z.string(), count: z.number(), done: z.boolean(), nothing: z.null(),
    note_ids: z.array(z.string()), updates: z.array(z.object({ row_id: z.string(), expected_rev: z.number() })),
    values: z.record(z.string(), z.unknown()), command: z.string(), args: z.string(), list: z.array(z.string()), nested: z.looseObject({}),
    token: z.string(), apiKey: z.string(), client_secret: z.string(), password: z.string(), passwd: z.string(), authorization: z.string(),
    credentials: z.string(), bearer: z.string(), cookie: z.string(), session: z.string(), idempotency_key: z.string(), pin: z.string(), flat: z.looseObject({}),
  });
  return vocabulary;
};
const vocabulary = vocabularyOfTestTools();
const excerptOf = (args: unknown) => argumentsExcerpt(args, vocabulary);
const parsedArguments = (args: unknown) => JSON.parse(excerptOf(args)) as Record<string, unknown>;

describe('the arguments kept in the activity log', () => {
  it('keeps a UUID, a ticket, a status, a model, a number and a boolean as they were given', () => {
    const sessionId = randomUUID();

    const kept = parsedArguments({ session_id: sessionId, ticket: 'ACT-3', status: 'in_progress', model: 'opus', count: 3, done: false, nothing: null });

    expect(kept).toEqual({ session_id: sessionId, ticket: 'ACT-3', status: 'in_progress', model: 'opus', count: 3, done: false, nothing: null });
  });

  it('keeps an identifier under a key that names one, in an array and in a nested object', () => {
    const kept = parsedArguments({ note_ids: ['n-1', 'n-2'], updates: [{ row_id: 'row:42', expected_rev: 2 }] });

    expect(kept).toEqual({ note_ids: ['n-1', 'n-2'], updates: [{ row_id: 'row:42', expected_rev: 2 }] });
  });

  it('stands a free text as its length alone, never its content nor a fingerprint', () => {
    const body = `curl -u user:${fakeSecret('probe')} https://example.test`;

    const kept = parsedArguments({ title: 'Plan', body_md: body, comment: 'employee-login-code-value-1234' });

    expect(kept).toEqual({ title: '[text len=4]', body_md: `[text len=${body.length}]`, comment: '[text len=30]' });
  });

  it('stands an identifier-shaped text as its mark when its key names no identifier', () => {
    const secret = fakeSecret('probe');

    expect(excerptOf({ title: secret, nested: { note: { value: secret } } })).not.toContain(secret);
  });

  it('stands a value longer than 64 characters as its mark, even under an identifier key', () => {
    const longIdentifier = `id-${'a'.repeat(62)}`;

    expect(parsedArguments({ updates: [{ row_id: longIdentifier }] }).updates).toEqual([{ row_id: '[text len=65]' }]);
  });

  it.each(['token', 'apiKey', 'client_secret', 'password', 'passwd', 'authorization', 'credentials', 'bearer', 'cookie', 'session', 'idempotency_key', 'pin'])(
    'hides whatever the key %s holds, a number or an identifier included',
    (key) => {
      const kept = parsedArguments({ [key]: { ticket: 'ACT-3', count: 1234 }, flat: { [key]: 'ACT-3' } });

      expect(JSON.stringify(kept)).not.toMatch(/ACT-3|1234/);
    },
  );

  it('cuts a structure deeper than four levels and an array or an object past 64 items', () => {
    const deep = { nested: { list: { nested: { list: { title: 'deep' } } } } };
    const wide = { note_ids: Array.from({ length: 70 }, (_, index) => `id-${index}`) };

    expect(parsedArguments(deep)).toEqual({ nested: { list: { nested: { list: '[cut]' } } } });
    expect(parsedArguments(wide).note_ids).toEqual([...Array.from({ length: 64 }, (_, index) => `id-${index}`), '[cut]']);
  });

  it('stands a credential the masker recognises as the secret mark, even shaped as an identifier', () => {
    const credential = ['s', 'k-'].join('') + 'a1'.repeat(12);

    expect(excerptOf({ updates: [{ row_id: credential }] })).not.toContain(credential);
  });
});

describe('the keys kept in the activity log', () => {
  it('stands a key that no tool names as its length, and hides its value', () => {
    const secret = fakeLetterSecret();

    const kept = parsedArguments({ [secret]: true, values: { 'Due date': 'ACT-3' } });

    expect(kept).toEqual({ [`[key len=${secret.length}]`]: '[secret]', values: { '[key len=8]': '[secret]' } });
  });

  it('keeps two unknown keys of the same length apart with an index', () => {
    const [first, second] = [fakeLetterSecret(), fakeLetterSecret()];

    const kept = parsedArguments({ [first]: 1, [second]: 2 });

    expect(Object.keys(kept)).toEqual([`[key len=${first.length}]`, `[key len=${second.length}]#2`]);
  });

  it('learns the keys of a nested schema: an object in an array, an optional, a union and a lazy schema', () => {
    const learning = new ParameterVocabulary();
    learning.learnToolSchema('a_nested_tool', {
      questions: z.array(z.object({ question_text: z.string(), reopens: z.string().optional() })).optional(),
      target_of: z.union([z.object({ store_ref: z.string() }), z.object({ note_ref: z.string() })]),
      tree: z.lazy(() => z.object({ leaf_count: z.number() })),
    });

    expect(['questions', 'question_text', 'reopens', 'target_of', 'store_ref', 'note_ref', 'tree', 'leaf_count'].every((key) => learning.has(key))).toBe(true);
    expect(learning.has('unknown_key')).toBe(false);
  });
});

describe('the values of an enumeration key', () => {
  it.each([
    ['status', 'todo'], ['status', 'done'], ['status', 'pending'], ['kind', 'law'], ['outcome', 'denied'], ['role', 'manager'],
    ['harness', 'claude-cli'], ['model', 'claude-opus-5-5'], ['mode', 'acceptEdits'], ['decision', 'approve'], ['verdict', 'no-go'], ['severity', 'findings'],
    ['code', 'note_not_found'],
  ])('keeps the %s %s, a member of its closed set', (key, value) => {
    expect(parsedArguments({ [key]: value })).toEqual({ [key]: value });
  });

  it.each([
    ['status', 'confidential'], ['kind', 'secretword'], ['category', 'lowercase'], ['outcome', 'fine'], ['role', 'admin'], ['harness', 'bash'],
    ['model', 'gpt-x'], ['mode', 'yolo'], ['decision', 'maybe'], ['verdict', 'perhaps'], ['severity', 'critical'], ['code', 'made_up_code'],
  ])(
    'stands the %s %s, outside its closed set, as its mark',
    (key, value) => {
      expect(parsedArguments({ [key]: value })).toEqual({ [key]: `[text len=${value.length}]` });
    },
  );
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
  const isMark = (text: string) => /^\[(text|key) len=\d+\](?:#\d+)?$|^\[(cut|secret)\]$/.test(text);

  it('never lets one of 200 texts out as it was given, and keeps only marks or short safe strings', () => {
    const texts = Array.from({ length: 200 }, randomText);

    for (const [index, text] of texts.entries()) {
      const key = KEYS[index % KEYS.length]!;
      const excerpt = excerptOf({ [key]: text, list: [text], nested: { [key]: text }, [text]: text });

      expect(excerpt).not.toContain(text);
      expect(excerpt).not.toContain(JSON.stringify(text).slice(1, -1));
      expect(stringLeavesOf(JSON.parse(excerpt)).every((leaf) => isMark(leaf) || SAFE_KEPT_STRING.test(leaf))).toBe(true);
    }
  });
});

describe('the result kept in the activity log', () => {
  it('keeps the size and the known scalar fields that pass the list, never a free text', () => {
    const noteId = randomUUID();
    const body = `--token ${fakeSecret('result')}`;
    const resultText = JSON.stringify({ id: noteId, status: 'todo', title: 'Plan', body_md: body, rev: 1 });

    expect(resultExcerpt(resultText, vocabulary)).toBe(`[result len=${resultText.length}] {"id":"${noteId}","status":"todo","rev":1}`);
  });

  it('drops a field whose key no tool names, the key included', () => {
    const secret = fakeLetterSecret();
    const resultText = JSON.stringify({ [secret]: true, rev: 2 });

    expect(resultExcerpt(resultText, vocabulary)).toBe(`[result len=${resultText.length}] {"rev":2}`);
  });

  it('keeps an error code under the key code, and nothing else under it', () => {
    expect(resultExcerpt('{"code":"not_found"}', vocabulary)).toBe('[result len=20] {"code":"not_found"}');
    expect(resultExcerpt('{"code":"made_up"}', vocabulary)).toBe('[result len=18]');
  });

  it('keeps only the size of a text that is not a JSON object', () => {
    const errorText = `error note_not_found: no note --password ${fakeSecret('error')}`;

    expect(resultExcerpt(errorText, vocabulary)).toBe(`[result len=${errorText.length}]`);
    expect(resultExcerpt('[1,2]', vocabulary)).toBe('[result len=5]');
  });
});

describe('the detail of a row', () => {
  it('keeps an error code of the grammar and the name of an error class', () => {
    expect(['note_not_found', 'proposal_not_found', 'TypeError', 'Error', 'ProposalNotFoundError', 'TimeoutException'].map(keptDetail))
      .toEqual(['note_not_found', 'proposal_not_found', 'TypeError', 'Error', 'ProposalNotFoundError', 'TimeoutException']);
  });

  it('stands an identifier-shaped text that is no error code and no class name as its length', () => {
    const secret = fakeSecret('detail');

    expect([secret, 'made_up_code', 'no-such-proposal', `boom --password ${secret}`].map(keptDetail))
      .toEqual([`[text len=${secret.length}]`, '[text len=12]', '[text len=16]', `[text len=${secret.length + 16}]`]);
  });
});

describe('a label and an identifier of a row', () => {
  it('keeps a safe token of at most 64 characters as a label, and stands a phrase as its length', () => {
    const phrase = `confidential prose ${fakeSecret('label')}`;

    expect(['dev-activity-mr1-sonnet', 'admin', phrase, 'x'.repeat(65)].map(keptLabel))
      .toEqual(['dev-activity-mr1-sonnet', 'admin', `[text len=${phrase.length}]`, '[text len=65]']);
  });

  it('keeps a safe token or a UUID as an identifier, and stands any other text as its length', () => {
    const uuid = randomUUID();

    expect([uuid, 'session-1', 'x --password y'].map(keptIdentifier)).toEqual([uuid, 'session-1', '[text len=14]']);
  });
});
