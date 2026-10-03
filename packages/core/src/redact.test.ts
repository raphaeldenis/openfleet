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

const NOISE_FLOOR_MILLISECONDS = 5;
const GENEROUS_CEILING_MILLISECONDS = 2000;
const hostileTextOf = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));
const fastestOfThree = (measure: () => number) => Math.min(measure(), measure(), measure());

/** Times `mask` on the unit repeated to 64 KiB and 256 KiB: 4x the input must cost less than 8x, whatever the machine's speed. */
const expectLinearGrowth = (unit: string, mask: (text: string) => string) => {
  const millisecondsFor = (size: number) => {
    const hostile = hostileTextOf(unit, size);
    return fastestOfThree(() => {
      const startedAt = performance.now();
      mask(hostile);
      return performance.now() - startedAt;
    });
  };
  const small = Math.max(millisecondsFor(64 * 1024), NOISE_FLOOR_MILLISECONDS);
  const large = millisecondsFor(256 * 1024);

  expect(large / small).toBeLessThan(8);
  expect(large).toBeLessThan(GENEROUS_CEILING_MILLISECONDS);
};

describe('maskedSecrets: the JSON and colon forms under a secret-named key', () => {
  it.each([
    ['a JSON string value', '{"token":"SYNTHETIC_SECRET_123"}', `{"token":"${MASK}"}`],
    ['a JSON value after a space, next to a plain field', '{"password": "SYNTHETIC_SECRET_123", "user": "ada"}', `{"password": "${MASK}", "user": "ada"}`],
    ['a single-quoted value', "{'api_key': 'SYNTHETIC_SECRET_123'}", `{'api_key': '${MASK}'}`],
    ['a value holding an escaped quote', '{"token":"SYNTHETIC\\"SECRET_123"}', `{"token":"${MASK}"}`],
    ['a JSON document escaped inside a JSON string', '{"body":"{\\"token\\":\\"SYNTHETIC_SECRET_123\\"}"}', `{"body":"{\\"token\\":\\"${MASK}\\"}"}`],
    ['a quoted value cut by the end of the text', '{"token":"SYNTHETIC_SECRET_123', `{"token":"${MASK}`],
    ['a colon form', 'token: SYNTHETIC_SECRET_123', `token: ${MASK}`],
    ['a password in a sentence', 'login failed, password: SYNTHETIC_SECRET_123 rejected', `login failed, password: ${MASK} rejected`],
    ['an environment dump', 'AWS_SECRET_ACCESS_KEY: SYNTHETIC_SECRET_123', `AWS_SECRET_ACCESS_KEY: ${MASK}`],
    ['an api_key colon form', 'api_key: SYNTHETIC_SECRET_123', `api_key: ${MASK}`],
    ['an API key header', 'X-Api-Key: SYNTHETIC_SECRET_123', `X-Api-Key: ${MASK}`],
    ['a YAML dump', 'client_secret: SYNTHETIC_SECRET_123\nretries: 3', `client_secret: ${MASK}\nretries: 3`],
    ['a value ended by a comma', 'token: SYNTHETIC_SECRET_123, retry in 5s', `token: ${MASK}, retry in 5s`],
    ['a value with no space after the colon', 'token:SYNTHETIC_SECRET_123', `token:${MASK}`],
  ])('masks %s', (_name, text, expected) => {
    expect(maskedSecrets(text)).toBe(expected);
  });

  it.each([
    ['prose where a short word follows the colon', 'the token: is expired'],
    ['a usage counter', 'tokens: 450000'],
    ['a usage counter in JSON', '{"max_tokens": 4096}'],
    ['a null value', '{"token": null}'],
    ['a boolean value', '{"hasToken": true}'],
    ['an empty value', '{"token":""}'],
    ['a key with no value', 'Enter your password:'],
    ['a colon whose key names no secret', 'host: localhost:7331 at 12:30:45'],
    ['an already masked colon form', 'password: ***'],
    ['an already masked JSON value', '{"token":"***"}'],
    ['an already masked Authorization header', 'Authorization: Bearer ***'],
  ])('leaves %s alone', (_name, text) => {
    expect(maskedSecrets(text)).toBe(text);
  });

  it.each([['{"token":"SYNTHETIC_SECRET_123"}'], ['password: SYNTHETIC_SECRET_123'], ['Authorization: Bearer SYNTHETIC_SECRET_123']])('masks %j the same way twice', (text) => {
    const once = maskedSecrets(text);

    expect(maskedSecrets(once)).toBe(once);
  });

  it('masks a quoted value that holds a line break up to the line break only', () => {
    expect(maskedSecrets('{"token":"SYNTHETIC_SECRET_123\nnext line')).toBe(`{"token":"${MASK}\nnext line`);
  });

  it('masks a quoted value of 10000 characters whole', () => {
    expect(maskedSecrets(`{"token":"${'a'.repeat(10_000)}"}`)).toBe(`{"token":"${MASK}"}`);
  });

  it('masks only a bounded start of a quoted value that never closes', () => {
    const endless = `{"token":"${'a'.repeat(100_000)}`;
    const masked = maskedSecrets(endless);

    expect(masked.startsWith(`{"token":"${MASK}`)).toBe(true);
    expect(masked.endsWith('a'.repeat(20_000))).toBe(true);
  });

  it('ends an unquoted value at an ampersand', () => {
    expect(maskedSecrets('token: SYNTHETIC_SECRET_123&page=2')).toBe(`token: ${MASK}&page=2`);
  });

  it.each([['Authorization::='], ['token:***}z='], ['/hooks/=/token=']])('masks %j the same way twice', (text) => {
    const once = maskedSecrets(text);

    expect(maskedSecrets(once)).toBe(once);
  });

  it.each(['token:', 'token: ', '"token":"', 'token:"', 'token:\\', 'a:', 'token:token:', 'token:***', "password: '", 'token:\\"a', 'api_key:1', 'a:b ', ':'])(
    'masks %j at 64 KiB and 256 KiB with 4x the input costing less than 8x',
    (unit) => expectLinearGrowth(unit, maskedSecrets),
  );
});

describe('maskedSecrets: Cookie and Set-Cookie headers', () => {
  it.each([
    ['a Cookie header', 'Cookie: session=SYNTHETIC_SECRET_123', `Cookie: session=${MASK}`],
    ['every pair of a Cookie header', 'Cookie: a=SECRETVAL1; b=SECRETVAL2; c=SECRETVAL3', `Cookie: a=${MASK}; b=${MASK}; c=${MASK}`],
    ['a Set-Cookie header, keeping its attributes', 'Set-Cookie: session=SYNTHETIC_SECRET_123; HttpOnly', `Set-Cookie: session=${MASK}; HttpOnly`],
    [
      'a Set-Cookie header with Path and Max-Age',
      'Set-Cookie: sid=SECRETVAL1; Path=/; Max-Age=3600; Secure; SameSite=Lax',
      `Set-Cookie: sid=${MASK}; Path=/; Max-Age=3600; Secure; SameSite=Lax`,
    ],
    ['a Set-Cookie header with an Expires date', 'set-cookie: id=SECRETVAL1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', `set-cookie: id=${MASK}; Expires=Wed, 21 Oct 2026 07:28:00 GMT`],
    ['a header inside a dumped response', '< Set-Cookie: session=SECRETVAL1; HttpOnly\r\n< Content-Type: text/html', `< Set-Cookie: session=${MASK}; HttpOnly\r\n< Content-Type: text/html`],
    ['a value holding an equals sign', 'Cookie: sid=SECRETVAL1==', `Cookie: sid=${MASK}`],
  ])('masks %s', (_name, text, expected) => {
    expect(maskedSecrets(text)).toBe(expected);
  });

  it.each([
    ['a cookie that deletes itself', 'Set-Cookie: session=; Max-Age=0'],
    ['the word cookie in prose', 'Cookie banner accepted'],
    ['a Cookie header with no value', 'Cookie: '],
    ['an already masked Cookie header', 'Cookie: session=***; theme=***'],
  ])('leaves %s alone', (_name, text) => {
    expect(maskedSecrets(text)).toBe(text);
  });

  it('does not touch the next line of a Cookie header', () => {
    expect(maskedSecrets('Cookie: a=SECRETVAL1\nx=plain')).toBe(`Cookie: a=${MASK}\nx=plain`);
  });

  it.each([['Cookie: session=SECRETVAL1; theme=dark'], ['Set-Cookie: sid=SECRETVAL1; Path=/']])('masks %j the same way twice', (text) => {
    const once = maskedSecrets(text);

    expect(maskedSecrets(once)).toBe(once);
  });

  it.each(['Cookie: ', 'Cookie: a=', 'Set-Cookie: a=b;', 'Cookie:a=b;c', 'Cookie', 'Cookie:   ', 'Set-Cookie: a=b; c=d; e', 'Cookie: aaaaaaaaaaaaaaaa'])(
    'masks %j at 64 KiB and 256 KiB with 4x the input costing less than 8x',
    (unit) => expectLinearGrowth(unit, maskedSecrets),
  );
});

describe('maskedSecrets: a JWT whose signature is missing', () => {
  const header = 'eyJhbGciOiJIUzI1NiJ9';
  const payload = 'eyJzdWIiOiIxMjM0NTY3ODkw';

  it.each([
    ['a JWT cut before its signature', `${header}.${payload}`],
    ['an unsigned JWT with an empty signature', `${header}.${payload}.`],
    ['a JWT with a signature shorter than the usual minimum', `${header}.${payload}.ab`],
  ])('masks %s', (_name, jwt) => {
    expect(maskedSecrets(`use ${jwt} now`)).toBe(`use ${MASK} now`);
  });

  it('leaves a lone JWT header alone', () => {
    expect(maskedSecrets(`header ${header} only`)).toBe(`header ${header} only`);
  });

  it.each(['eyJ', '-eyJaaaaaa.eyJaaaaaa.', 'eyJaaaaaa.eyJaaaaaa', 'eyJaaaaaa.eyJ.'])('masks %j at 64 KiB and 256 KiB with 4x the input costing less than 8x', (unit) =>
    expectLinearGrowth(unit, maskedSecrets),
  );
});

describe('maskingCutCredential: an incomplete JWT tail, whatever the length of its payload', () => {
  const header = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9';

  it.each([100, 508, 512, 600, 5000, 5100])('masks a header followed by a %i character payload prefix with no signature', (payloadLength) => {
    const head = `Fix CI ${header}.eyJ${'a'.repeat(payloadLength)}`;

    expect(maskingCutCredential(head)).toBe(`Fix CI ${MASK}`);
    expect(maskedSecrets(maskingCutCredential(head))).toBe(`Fix CI ${MASK}`);
  });

  it('masks a payload prefix too short for the ordinary JWT rule', () => {
    expect(maskingCutCredential(`Fix CI ${header}.eyJab`)).toBe(`Fix CI ${MASK}`);
  });

  it('keeps what precedes the JWT header', () => {
    expect(maskingCutCredential(`user=ada token=${header}.eyJ${'b'.repeat(900)}`)).toBe(`user=ada token=${MASK}`);
  });

  it('leaves a long ordinary run of word characters alone', () => {
    const plain = `Fix CI ${'a'.repeat(5000)}`;

    expect(maskingCutCredential(plain)).toBe(plain);
  });

  it('leaves a dotted run whose first segment is not a JWT header alone', () => {
    const plain = `Fix CI config.${'a'.repeat(900)}`;

    expect(maskingCutCredential(plain)).toBe(plain);
  });

  it.each(['-eyJ', '.eyJ', 'eyJa.eyJ', 'eyJaaaaaaaa.eyJ', 'sk-', 'a.', '%2F', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])(
    'cuts %j at 64 KiB and 256 KiB with 4x the input costing less than 8x',
    (unit) => expectLinearGrowth(unit, maskingCutCredential),
  );
});

describe('maskedSecrets: one rule for the next-line character (U+0085)', () => {
  const nextLine = '\u0085';

  it('masks a Bearer token after a next-line separator', () => {
    expect(maskedSecrets(`Bearer${nextLine}SYNTHETIC_SECRET_123`)).toBe(`Bearer ${MASK}`);
  });

  it('masks a secret parameter that follows a next-line character', () => {
    expect(maskedSecrets(`a=x${nextLine}token=SECRETVAL1`)).toBe(`a=x${nextLine}token=${MASK}`);
  });

  it('ends a URL authority at a next-line character', () => {
    expect(maskedSecrets(`https://u:p${nextLine}x@host/`)).toBe(`https://u:p${nextLine}x@host/`);
  });

  it('ends a hook token at a next-line character', () => {
    expect(maskedSecrets(`/hooks/tok123${nextLine}keep`)).toBe(`/hooks/${MASK}${nextLine}keep`);
  });

  it.each([['\u0085'], ['Bearer\u0085'], ['a=\u0085token=']])('masks %j at 64 KiB and 256 KiB with 4x the input costing less than 8x', (unit) =>
    expectLinearGrowth(unit, maskedSecrets),
  );
});

describe('maskedSecrets: idempotence', () => {
  it('masks a hook segment whose leftover looks like a parameter the same way twice', () => {
    const once = maskedSecrets('/hooks/=/token=');

    expect(maskedSecrets(once)).toBe(once);
  });

  it('keeps masking the secret parameter that follows a masked hook token', () => {
    expect(maskedSecrets('/hooks/=/token=')).toBe(`/hooks/${MASK}/token=${MASK}`);
  });

  const pieces = [
    '?', '#', '@', '://', '=', '&', ';', ':', '%', '%3F', '%23', '%40', 'é', '日', '\u0085', '﻿', 'Bearer', 'Basic', 'Authorization:', 'token', 'a=', '/hooks/',
    '***', ' ', '\n', '"', "'", '\\"', '{', '}', ',', 'Cookie: ', 'Set-Cookie: ', 'password: ', '"token":', 'eyJabcdef.eyJabcdef', 'sk-', 'x'.repeat(24),
  ];
  const corpusOf = (count: number) => {
    let seed = 139;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    return Array.from({ length: count }, () =>
      Array.from({ length: next() % 30 }, () => pieces[next() % pieces.length]).join(''),
    );
  };

  it('masks every vector of a 6000-vector corpus the same way twice', () => {
    const notIdempotent = corpusOf(6000).filter((text) => maskedSecrets(maskedSecrets(text)) !== maskedSecrets(text));

    expect(notIdempotent).toEqual([]);
  });
});
