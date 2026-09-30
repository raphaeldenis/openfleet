import { describe, expect, it } from 'vitest';
import { MASK, maskedSecrets } from './redact.js';

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
});
