import { describe, expect, it } from 'vitest';
import { MASK, maskedSecrets, maskingCutCredential } from './redact.js';

const millisecondsToMask = (text: string): number => {
  const start = performance.now();
  maskedSecrets(text);
  return performance.now() - start;
};

const millisecondsToMaskCut = (text: string): number => {
  const start = performance.now();
  maskingCutCredential(text);
  return performance.now() - start;
};

describe('maskedSecrets: ReDoS guard on the well-known formats', () => {
  const hostileInputs = [
    ['a run of JWT starts', '-eyJ'],
    ['a run of sk- starts', '-sk-'],
    ['a run of PEM headers', '-----BEGIN PRIVATE KEY-----'],
    ['a run of key-block words', '-----BEGIN A A A A '],
    ['a run of Slack starts', '-xoxb-'],
    ['a run of npm starts', '-npm_'],
    ['a run of glpat starts', '-glpat-'],
    ['a run of AIza starts', '-AIza'],
    ['a run of live-key starts', '-sk_live_'],
  ] as const;

  it.each(hostileInputs)('masks %s at 256 KiB in well under a second', (_name, unit) => {
    const hostile = unit.repeat(Math.ceil((256 * 1024) / unit.length));

    expect(millisecondsToMask(hostile)).toBeLessThan(250);
  });

  it('scales linearly: a 4x longer run of JWT starts costs less than 8x', () => {
    const unit = '-eyJ';
    millisecondsToMask(unit.repeat(1024));
    const small = Math.max(millisecondsToMask(unit.repeat(16_384)), 0.5);
    const large = millisecondsToMask(unit.repeat(65_536));

    expect(large / small).toBeLessThan(8);
  });
});

describe('maskedSecrets: well-known key formats', () => {
  it('masks an Anthropic or OpenAI style sk- key written in prose', () => {
    const masked = maskedSecrets('use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 for the call');
    expect(masked).toBe(`use ${MASK} for the call`);
  });

  it('masks a GitHub personal access token and a fine-grained one', () => {
    const classic = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;
    const fineGrained = `github_pat_${'A1b2C3d4E5'.repeat(6)}`;
    expect(maskedSecrets(`token ${classic} and ${fineGrained}`)).toBe(`token ${MASK} and ${MASK}`);
  });

  it('masks an AWS access key id', () => {
    expect(maskedSecrets('key AKIAIOSFODNN7EXAMPLE here')).toBe(`key ${MASK} here`);
  });

  it('masks a JSON Web Token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(maskedSecrets(`jwt=${jwt}!`)).not.toContain('eyJzdWIi');
    expect(maskedSecrets(`value ${jwt}`)).toBe(`value ${MASK}`);
  });

  it('masks a PEM private key block from its header to its footer', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\nabcdef\n-----END RSA PRIVATE KEY-----';
    expect(maskedSecrets(`before ${pem} after`)).toBe(`before ${MASK} after`);
  });

  it('masks a PEM header whose footer the text was cut before', () => {
    expect(maskedSecrets('x -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq')).toBe(`x ${MASK}`);
  });

  it('leaves the words that only look like a key prefix untouched', () => {
    const plain = 'ask about sk-1, the ghp_ prefix, AKIA alone and eyJ fragments';
    expect(maskedSecrets(plain)).toBe(plain);
  });

  it('keeps masking the previous shapes (Bearer) next to a known key', () => {
    expect(maskedSecrets('Authorization: Bearer abc.def and AKIAIOSFODNN7EXAMPLE')).toBe(`Authorization: Bearer ${MASK} and ${MASK}`);
  });

  it.each([['gho_'], ['ghu_'], ['ghs_'], ['ghr_']])('masks a GitHub %s token as well as a ghp_ one', (prefix) => {
    expect(maskedSecrets(`use ${prefix}${'a1B2c3D4e5'.repeat(4)} now`)).toBe(`use ${MASK} now`);
  });

  it('masks an AWS temporary access key id (ASIA)', () => {
    expect(maskedSecrets('key ASIAIOSFODNN7EXAMPLE here')).toBe(`key ${MASK} here`);
  });

  it('leaves an AKIA id followed by more word characters alone: it is not a key id', () => {
    const plain = 'AKIAIOSFODNN7EXAMPLEXTRA';
    expect(maskedSecrets(plain)).toBe(plain);
  });

  it('does not mask a JWT glued after a dash or an underscore, which keeps the scan linear', () => {
    expect(maskedSecrets('x-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP')).toContain('eyJzdWIi');
  });
});

describe('maskedSecrets: the other provider key formats', () => {
  const credentials = [
    ['a Slack bot token', `xoxb-${'1234567890'.repeat(2)}-AbCdEfGhIj`],
    ['a Slack user token', `xoxp-${'1234567890'.repeat(2)}-AbCdEfGhIj`],
    ['a Slack app token', `xapp-1-A0123456789-${'1234567890'.repeat(2)}`],
    ['a Google API key', `AIza${'AbCdEfGhIj'.repeat(3)}_-AbC`],
    ['an npm token', `npm_${'aB3dE6gH9j'.repeat(3)}aB3dE6`],
    ['a GitLab personal access token', `glpat-${'aB3dE6gH9j'.repeat(2)}`],
    ['a Stripe live secret key', `sk_live_${'aB3dE6gH9j'.repeat(2)}`],
    ['a Stripe live restricted key', `rk_live_${'aB3dE6gH9j'.repeat(2)}`],
  ] as const;

  it.each(credentials)('masks %s', (_name, credential) => {
    expect(maskedSecrets(`use ${credential} now`)).toBe(`use ${MASK} now`);
  });

  it('masks a PGP private key block whose header carries the word BLOCK', () => {
    const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBF\n-----END PGP PRIVATE KEY BLOCK-----';
    expect(maskedSecrets(`before ${pgp} after`)).toBe(`before ${MASK} after`);
  });
});

describe('maskingCutCredential: a well-known credential the head cut left in part', () => {
  const cutCredentials = [
    ['an sk- key', 'sk-proj-AbCdEfGhI'],
    ['a GitHub token', `ghp_${'a1B2c3D4e5'.repeat(2)}`],
    ['a fine-grained GitHub token', 'github_pat_11AAAA'],
    ['an AWS key id', 'AKIAIOSFODNN'],
    ['an AWS temporary key id', 'ASIAIOSFODNN'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx'],
    ['a Slack bot token', 'xoxb-1234567'],
    ['a Slack app token', 'xapp-1-A0123'],
    ['a Google API key', 'AIzaSyA1b2C3d4'],
    ['an npm token', 'npm_aB3dE6gH9j'],
    ['a GitLab token', 'glpat-aB3dE6gH9j'],
    ['a Stripe live secret key', 'sk_live_aB3dE6'],
    ['a Stripe live restricted key', 'rk_live_aB3dE6'],
  ] as const;

  it('masks a prefix that follows a dash inside the final run', () => {
    expect(maskingCutCredential('Fix CI x-sk-abc')).toBe(`Fix CI x-${MASK}`);
  });

  it.each(cutCredentials)('masks %s at the very end of the head', (_name, credential) => {
    expect(maskingCutCredential(`Fix CI ${credential}`)).toBe(`Fix CI ${MASK}`);
  });

  it('leaves a key prefix in the middle of the head to the ordinary rules', () => {
    expect(maskingCutCredential('the sk-1 prefix, then more')).toBe('the sk-1 prefix, then more');
  });

  it('masks a Slack token after a whitespace run the collapse left behind', () => {
    const head = `Fix CI${' '.repeat(250)}xoxb-12345`;
    expect(maskingCutCredential(head)).toBe(`Fix CI${' '.repeat(250)}${MASK}`);
  });

  it('stays linear on a long run of repeated prefixes ending in a non-credential character', () => {
    const millisecondsFor = (repeats: number) => {
      const hostile = `${'sk-'.repeat(repeats)}!`;
      const startedAt = performance.now();
      maskingCutCredential(hostile);
      return performance.now() - startedAt;
    };
    const small = Math.max(millisecondsFor(8192), 1);
    const fourTimesLarger = millisecondsFor(32768);
    expect(fourTimesLarger / small).toBeLessThan(8);
    expect(fourTimesLarger).toBeLessThan(500);
  });
});

describe('maskedSecrets: a secret parameter nested inside another parameter or a URL fragment', () => {
  it.each([
    ['a nested query parameter', 'GET /cb?page=a?token=SECRETVAL1', 'GET /cb?page=a?token=***'],
    ['a nested parameter at the start of the text', 'page=a?token=SECRETVAL1', 'page=a?token=***'],
    ['a nested parameter two levels deep', 'GET /cb?next=a?x=b?password=SECRETVAL1', 'GET /cb?next=a?x=b?password=***'],
    ['a nested parameter in a fragment of a value', 'page=a#access_token=SECRETVAL1', 'page=a#access_token=***'],
    ['an OAuth fragment', 'GET /cb#access_token=SECRETVAL1', 'GET /cb#access_token=***'],
    ['an OAuth fragment after other fragment parameters', 'GET /cb#state=1&access_token=SECRETVAL1', 'GET /cb#state=1&access_token=***'],
    ['a fragment that starts the text', '#token=SECRETVAL1', '#token=***'],
    ['a secret key that keeps its whole value, question mark included', 'GET /x?password=ab?cdSECRETVAL1', 'GET /x?password=***'],
    ['a value nested deeper than the check reaches', 'GET /x?page=a?b=c?d=e?f=g?h=i?j=SECRETVAL1', 'GET /x?page=***'],
  ])('masks %s', (_name, text, expected) => {
    expect(maskedSecrets(text)).toBe(expected);
  });

  it.each([['GET /docs#section=intro'], ['GET /x?a=1?b=2'], ['GET /x?page=a#top'], ['see issue #42 and ?q=tokenless']])('leaves %s alone', (text) => {
    expect(maskedSecrets(text)).toBe(text);
  });
});

describe('maskedSecrets: a Bearer prefix written more than once', () => {
  it.each([
    ['Authorization: Bearer Bearer SECRETVAL1', 'Authorization: Bearer ***'],
    ['Authorization: bearer:BEARER=Bearer SECRETVAL1', 'Authorization: Bearer ***'],
    ['Authorization: Bearer%20Bearer%20SECRETVAL1', 'Authorization: Bearer ***'],
  ])('masks the token behind %s', (text, expected) => {
    expect(maskedSecrets(text)).toBe(expected);
  });

  it('leaves the word Bearer in prose alone', () => {
    expect(maskedSecrets('BearerAuth failed, a Bearer')).toBe('BearerAuth failed, a Bearer');
  });
});

describe('maskedSecrets: a URL password holding a raw at-sign', () => {
  it('masks up to the last at-sign of the authority', () => {
    expect(maskedSecrets('connect https://u:p@ssSECRETVAL1@host/x failed')).toBe(`connect https://${MASK}@host/x failed`);
  });

  it('leaves a path holding an at-sign alone', () => {
    expect(maskedSecrets('GET https://host/users/a@b')).toBe('GET https://host/users/a@b');
  });
});

describe('maskedSecrets: provider key formats added after the first round', () => {
  const credentials = [
    ['a Slack rotation token', `xoxe-1-${'1234567890'.repeat(2)}`],
    ['a Slack configuration token', `xoxe.xoxp-1-${'1234567890'.repeat(2)}`],
    ['a Slack cookie token', 'xoxd-aB3dE6gH9j%2BaB3dE6gH9j'],
    ['a Slack client token', `xoxc-${'1234567890'.repeat(2)}`],
    ['a Hugging Face token', `hf_${'aB3dE6gH9j'.repeat(3)}aB3d`],
    ['a Stripe test secret key', `sk_test_${'aB3dE6gH9j'.repeat(2)}`],
    ['a Stripe restricted test key', `rk_test_${'aB3dE6gH9j'.repeat(2)}`],
    ['a Stripe webhook secret', `whsec_${'aB3dE6gH9j'.repeat(3)}`],
    ['a Google API key with a longer tail', `AIza${'AbCdEfGhIj'.repeat(3)}_-AbCdEfGhIj`],
    ['a routable GitLab token', `glpat-${'aB3dE6gH9j'.repeat(2)}.01.aB3dE6gH9`],
  ] as const;

  it.each(credentials)('masks %s', (_name, credential) => {
    expect(maskedSecrets(`use ${credential} now`)).toBe(`use ${MASK} now`);
  });

  it.each([
    ['task and risk words', 'the task-list and risk-register, a chf_ value, whsec alone, hf_transfer_enabled and a sk_testing run'],
    ['a short Hugging Face look-alike', 'hf_abcdef is not a token'],
    ['a short whsec look-alike', 'whsec_short is not a secret'],
  ])('leaves %s alone', (_name, plain) => {
    expect(maskedSecrets(plain)).toBe(plain);
  });

  it.each([
    ['a Slack rotation token', 'xoxe-1-123456'],
    ['a Slack cookie token', 'xoxd-aB3dE6gH9j'],
    ['a Slack configuration token', 'xoxe.xoxp-1-1234'],
    ['a Hugging Face token', 'hf_aB3dE6gH9j'],
    ['a Stripe test secret key', 'sk_test_aB3dE6'],
    ['a Stripe webhook secret', 'whsec_aB3dE6gH'],
  ])('masks %s at the very end of a head cut', (_name, credential) => {
    expect(maskingCutCredential(`Fix CI ${credential}`)).toBe(`Fix CI ${MASK}`);
  });

  it('masks a Slack cookie token cut inside its escapes', () => {
    expect(maskingCutCredential('token xoxd-abc%2Fde')).toBe(`token ${MASK}`);
  });

  it('keeps a long run of escapes before a cut linear', () => {
    const escapes = '%2F'.repeat(200_000);
    const small = Math.max(millisecondsToMaskCut(escapes.slice(0, 50_000)), 5);
    const large = millisecondsToMaskCut(escapes);

    expect(large / small).toBeLessThan(8);
  });
});

describe('maskedSecrets: a regression to quadratic time fails fast', () => {
  const nestedParameterShapes = ['a=?', 'a=#', '?#', 'a=b?c=d?e=f?g=h&', 'a=', 'a=%3F', 'a=%2525%2525%25'];
  const repeatedTo = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));

  it.each(nestedParameterShapes)('masks %j at 64 KiB and 256 KiB with 4x the input costing less than 8x', (unit) => {
    const small = Math.max(millisecondsToMask(repeatedTo(unit, 64 * 1024)), 5);
    const large = millisecondsToMask(repeatedTo(unit, 256 * 1024));

    expect(large / small).toBeLessThan(8);
  });

  // Each nested `a=` peels three layers off the deep escape, so the decoding recursion runs once per pair.
  const chainBeforeDeepEscape = (pairs: number) => `${'a='.repeat(pairs)}%${'25'.repeat(3 * pairs)}41`;

  it('masks a 64 KiB chain of nested parameters before a deeply escaped byte without throwing', () => {
    expect(() => maskedSecrets(chainBeforeDeepEscape(8_000))).not.toThrow();
  });

  it('masks a chain of nested parameters before a deeply escaped byte in linear time', () => {
    const small = Math.max(millisecondsToMask(chainBeforeDeepEscape(1_000)), 5);
    const large = millisecondsToMask(chainBeforeDeepEscape(4_000));

    expect(large / small).toBeLessThan(8);
  });

  it('masks a value whose escapes nest deeper than the check reaches', () => {
    expect(maskedSecrets(chainBeforeDeepEscape(6))).toBe(`a=${MASK}`);
  });
});

describe('maskedSecrets: the hardened rules stay linear', () => {
  const hostileUnits = [
    '?a=', 'page=a?', 'a=?a=', '#a=', 'a=#a=', 'page=%25?', 'a=%2F?#', 'token=a?',
    'Bearer Bearer ', 'Bearer Bearer', 'Bearer %42earer ',
    '://a@', '://a@@', '://@', '://a@a/',
    'xoxe.', 'xoxe.xoxp-', 'xoxd-', 'hf_', 'whsec_', 'sk_test_', '-AIza', 'glpat-aaaaaaaaaaaaaaaaaaaa.01.',
  ];
  const repeatedTo = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));
  const fastestMillisecondsFor = (text: string) => Math.min(...[0, 1, 2].map(() => millisecondsToMask(text)));

  it.each(hostileUnits)('masks %j at 256 KiB and 1 MiB with 4x the input costing less than 8x', (unit) => {
    const small = Math.max(fastestMillisecondsFor(repeatedTo(unit, 256 * 1024)), 5);
    const large = fastestMillisecondsFor(repeatedTo(unit, 1024 * 1024));

    expect(large / small).toBeLessThan(8);
    expect(large).toBeLessThan(2000);
  });
});
