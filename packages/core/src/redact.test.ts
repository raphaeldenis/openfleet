import { describe, expect, it } from 'vitest';
import { MASK, maskedSecrets, maskingCutCredential } from './redact.js';

const millisecondsToMask = (text: string): number => {
  const start = performance.now();
  maskedSecrets(text);
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
