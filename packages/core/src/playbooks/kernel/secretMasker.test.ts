import { describe, expect, it } from 'vitest';
import { KernelError } from './kernelError.js';
import { createSecretMasker } from './secretMasker.js';

const codeOfThrown = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof KernelError ? error.code : 'not_a_kernel_error';
  }
  return undefined;
};

// Fake secrets are assembled at run time: no literal in the source looks like a credential.
const jiraValue = ['correct', 'horse', 'battery'].join('-');
const awkwardValue = ['p@ss', 'w/rd&x=1', '"q"\\n'].join(' ');
const maskerOfJira = () => createSecretMasker([{ name: 'JIRA_TOKEN', value: jiraValue }]);

describe('createSecretMasker: forms of one value', () => {
  it('replaces the plain value by its name', () => {
    expect(maskerOfJira().mask(`Authorization failed for ${jiraValue}.`)).toBe('Authorization failed for [secret:JIRA_TOKEN].');
  });

  it('leaves the rest of the text readable', () => {
    expect(maskerOfJira().mask('status: In Progress, assignee: ada')).toBe('status: In Progress, assignee: ada');
  });

  it('replaces the URL-encoded value', () => {
    const masker = createSecretMasker([{ name: 'AWKWARD', value: awkwardValue }]);

    expect(masker.mask(`GET /x?k=${encodeURIComponent(awkwardValue)}`)).toBe('GET /x?k=[secret:AWKWARD]');
  });

  it('replaces the form-encoded value, where a space is a plus', () => {
    const masker = createSecretMasker([{ name: 'AWKWARD', value: awkwardValue }]);
    const formEncoded = encodeURIComponent(awkwardValue).replaceAll('%20', '+');

    expect(masker.mask(`body=${formEncoded}`)).toBe('body=[secret:AWKWARD]');
  });

  it('replaces the base64 value, with or without its padding', () => {
    const encoded = Buffer.from(jiraValue).toString('base64');
    const unpadded = encoded.replace(/=+$/, '');

    expect(maskerOfJira().mask(`token=${unpadded}`)).not.toContain(unpadded);
    expect(maskerOfJira().mask(`token=${encoded}`)).not.toContain(unpadded);
    expect(maskerOfJira().mask(`token=${unpadded}`)).toContain('[secret:JIRA_TOKEN]');
  });

  it('replaces the base64url value', () => {
    const masker = createSecretMasker([{ name: 'AWKWARD', value: awkwardValue }]);
    const encoded = Buffer.from(awkwardValue).toString('base64url');

    expect(masker.mask(`jwt.${encoded}.sig`)).toBe('jwt.[secret:AWKWARD].sig');
  });

  it('replaces the JSON-escaped value, quotes and backslashes included', () => {
    const masker = createSecretMasker([{ name: 'AWKWARD', value: awkwardValue }]);
    const jsonDocument = JSON.stringify({ header: awkwardValue });

    expect(masker.mask(jsonDocument)).toBe('{"header":"[secret:AWKWARD]"}');
  });

  it('treats regular-expression characters in a value literally', () => {
    const masker = createSecretMasker([{ name: 'REGEXY', value: ['a.b*c', '(d)[e]+'].join('') }]);

    expect(masker.mask('x a.b*c(d)[e]+ y aXb*c(d)[e]+')).toBe('x [secret:REGEXY] y aXb*c(d)[e]+');
  });
});

describe('createSecretMasker: re-spellings of the same value', () => {
  const probeValue = ['abc', 'é', '/', 'xyz1'].join('');
  const maskerOfProbe = () => createSecretMasker([{ name: 'PROBE', value: probeValue }]);
  const withLowercaseHex = (urlEncoded: string) => urlEncoded.replace(/%[0-9A-F]{2}/g, (sequence) => sequence.toLowerCase());

  it('replaces the URL-encoded value written with lowercase hexadecimal', () => {
    expect(maskerOfProbe().mask(`k=${withLowercaseHex(encodeURIComponent(probeValue))}`)).toBe('k=[secret:PROBE]');
  });

  it('replaces the URL-encoded value written with mixed-case hexadecimal', () => {
    expect(maskerOfProbe().mask('k=abc%c3%A9%2fxyz1')).toBe('k=[secret:PROBE]');
  });

  it('replaces the form-encoded value written with lowercase hexadecimal', () => {
    const masker = createSecretMasker([{ name: 'AWKWARD', value: awkwardValue }]);
    const formEncoded = withLowercaseHex(encodeURIComponent(awkwardValue)).replaceAll('%20', '+');

    expect(masker.mask(`body=${formEncoded}`)).toBe('body=[secret:AWKWARD]');
  });

  it.each([
    ['lowercase', 'abc\\u00e9/xyz1'],
    ['uppercase', 'abc\\u00E9/xyz1'],
    ['lowercase with an escaped slash', 'abc\\u00e9\\/xyz1'],
    ['uppercase with an escaped slash', 'abc\\u00E9\\/xyz1'],
    ['unescaped non-ASCII with an escaped slash', 'abcé\\/xyz1'],
  ])('replaces the JSON value whose non-ASCII character is escaped as \\uXXXX, %s', (_label, jsonText) => {
    expect(maskerOfProbe().mask(`{"k":"${jsonText}"}`)).toBe('{"k":"[secret:PROBE]"}');
  });

  it.each(['\\ud83d\\udd11', '\\uD83D\\uDD11', '\\ud83D\\uDd11'])('replaces a value made of surrogate pairs written %s', (escapedKey) => {
    const masker = createSecretMasker([{ name: 'KEYS', value: '🔑'.repeat(8) }]);

    expect(masker.mask(`"${escapedKey.repeat(8)}"`)).toBe('"[secret:KEYS]"');
  });

  it('keeps naming the owner of a value matched through another hexadecimal case', () => {
    const masker = createSecretMasker([
      { name: 'PROBE', value: probeValue },
      { name: 'JIRA_TOKEN', value: jiraValue },
    ]);

    expect(masker.mask(`${withLowercaseHex(encodeURIComponent(probeValue))} ${jiraValue}`)).toBe('[secret:PROBE] [secret:JIRA_TOKEN]');
  });

  it('does not replace another value that differs by more than the hexadecimal case', () => {
    expect(maskerOfProbe().mask('k=abc%c3%a8%2fxyz1 j=abc\\u00e8/xyz1')).toBe('k=abc%c3%a8%2fxyz1 j=abc\\u00e8/xyz1');
  });
});

describe('createSecretMasker: occurrences', () => {
  it('replaces a secret in the middle of a word', () => {
    expect(maskerOfJira().mask(`pre${jiraValue}post`)).toBe('pre[secret:JIRA_TOKEN]post');
  });

  it('replaces every occurrence of a repeated secret', () => {
    expect(maskerOfJira().mask(`${jiraValue} and ${jiraValue}${jiraValue}`)).toBe('[secret:JIRA_TOKEN] and [secret:JIRA_TOKEN][secret:JIRA_TOKEN]');
  });

  it('masks several secrets by their own names', () => {
    const masker = createSecretMasker([
      { name: 'JIRA_TOKEN', value: jiraValue },
      { name: 'DB_PASSWORD', value: ['unrelated', 'phrase', '42'].join('_') },
    ]);

    expect(masker.mask(`a ${['unrelated', 'phrase', '42'].join('_')} b ${jiraValue}`)).toBe('a [secret:DB_PASSWORD] b [secret:JIRA_TOKEN]');
  });

  it('documented limit: a secret split across two calls is not recognised by either call', () => {
    const firstHalf = jiraValue.slice(0, 9);
    const secondHalf = jiraValue.slice(9);

    expect(maskerOfJira().mask(firstHalf)).toBe(firstHalf);
    expect(maskerOfJira().mask(secondHalf)).toBe(secondHalf);
  });

  it('returns the text unchanged when no secret is declared', () => {
    expect(createSecretMasker([]).mask('anything')).toBe('anything');
  });
});

describe('createSecretMasker: overlapping secrets', () => {
  const short = 'abcdefgh';
  const long = 'abcdefghij';

  it('masks by the longest when a secret starts the same way as another', () => {
    const masker = createSecretMasker([
      { name: 'SHORT', value: short },
      { name: 'LONG', value: long },
    ]);

    expect(masker.mask(`x ${long} y`)).toBe('x [secret:LONG] y');
  });

  it('masks by the longest whatever the order of declaration', () => {
    const masker = createSecretMasker([
      { name: 'LONG', value: long },
      { name: 'SHORT', value: short },
    ]);

    expect(masker.mask(`x ${long} y ${short} z`)).toBe('x [secret:LONG] y [secret:SHORT] z');
  });

  it('masks a secret contained inside a longer one by the longer', () => {
    const container = ['xx', 'abcdefgh', 'yy'].join('');
    const masker = createSecretMasker([
      { name: 'INNER', value: 'abcdefgh' },
      { name: 'OUTER', value: container },
    ]);

    expect(masker.mask(`<${container}>`)).toBe('<[secret:OUTER]>');
  });

  it('hides both when two secrets overlap without containing each other', () => {
    const masker = createSecretMasker([
      { name: 'FIRST', value: 'abcdefgh12' },
      { name: 'SECOND', value: 'gh12ijklmn' },
    ]);

    const masked = masker.mask('xx abcdefgh12ijklmn yy');

    expect(masked).toBe('xx [secret:FIRST][secret:SECOND] yy');
    expect(masked).not.toContain('ijklmn');
  });
});

describe('createSecretMasker: refused secrets', () => {
  it('refuses a 7-character secret with secret_too_short', () => {
    expect(codeOfThrown(() => createSecretMasker([{ name: 'TOO_SHORT', value: 'abcdefg' }]))).toBe('secret_too_short');
  });

  it('accepts an 8-character secret', () => {
    expect(createSecretMasker([{ name: 'JUST_ENOUGH', value: 'abcdefgh' }]).mask('x abcdefgh')).toBe('x [secret:JUST_ENOUGH]');
  });

  it('counts characters, not UTF-16 units: seven emoji are too short', () => {
    expect(codeOfThrown(() => createSecretMasker([{ name: 'EMOJI', value: '🔑'.repeat(7) }]))).toBe('secret_too_short');
    expect(codeOfThrown(() => createSecretMasker([{ name: 'EMOJI', value: '🔑'.repeat(8) }]))).toBeUndefined();
  });

  it('refuses the whole set when one secret is too short', () => {
    const secrets = [
      { name: 'JIRA_TOKEN', value: jiraValue },
      { name: 'TOO_SHORT', value: 'short' },
    ];

    expect(codeOfThrown(() => createSecretMasker(secrets))).toBe('secret_too_short');
  });

  it('refuses a name that could forge another marker with invalid_secret_name', () => {
    expect(codeOfThrown(() => createSecretMasker([{ name: 'A] [secret:B', value: jiraValue }]))).toBe('invalid_secret_name');
  });
});

describe('createSecretMasker: linear cost', () => {
  it('masks a text of 1 000 000 characters in under 200 ms', () => {
    const masker = createSecretMasker([
      { name: 'JIRA_TOKEN', value: jiraValue },
      { name: 'AWKWARD', value: awkwardValue },
    ]);
    const chunk = `${'lorem ipsum dolor sit amet '.repeat(300)}${jiraValue} ${encodeURIComponent(awkwardValue)} `;
    const text = chunk.repeat(Math.ceil(1_000_000 / chunk.length)).slice(0, 1_000_000);

    const startedAt = performance.now();
    const masked = masker.mask(text);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(text).toHaveLength(1_000_000);
    expect(masked).not.toContain(jiraValue);
    expect(elapsedMilliseconds).toBeLessThan(200);
  });

  it('masks 1 000 000 characters that are one repeated secret in under 200 ms', () => {
    const text = `${jiraValue} `.repeat(Math.ceil(1_000_000 / (jiraValue.length + 1))).slice(0, 1_000_000);

    const startedAt = performance.now();
    const masked = maskerOfJira().mask(text);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(masked).not.toContain(jiraValue);
    expect(elapsedMilliseconds).toBeLessThan(200);
  });
});
