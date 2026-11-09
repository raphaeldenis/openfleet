import { describe, expect, it } from 'vitest';
import { credentialEchoMaskerOf } from './credentialEchoMasker.js';

const TOKEN = 'ATATT3xFfGF0-token-0123456789';
const CREDENTIAL = `ada@example.com:${TOKEN}`;
const AUTHORIZATION = `Basic ${Buffer.from(CREDENTIAL).toString('base64')}`;
const MARKER = '[secret:INTEGRATION_CREDENTIAL]';

const maskOfJira = () => credentialEchoMaskerOf({ credential: CREDENTIAL, authorization: AUTHORIZATION });

describe('masking what a provider echoes of a credential', () => {
  it.each([
    ['the credential', CREDENTIAL],
    ['the token alone, after the colon of an email:token credential', TOKEN],
    ['the whole Authorization header value', AUTHORIZATION],
    ['the base64 of the credential, as it travels in a Basic header', Buffer.from(CREDENTIAL).toString('base64')],
    ['the base64 of the token alone, its padding aside', Buffer.from(TOKEN).toString('base64').replace(/=+$/, '')],
    ['the credential URL-encoded', encodeURIComponent(CREDENTIAL)],
  ])('masks %s', (_label, echo) => {
    const masked = maskOfJira()(`before ${echo} after`);

    expect(masked).toBe(`before ${MARKER} after`);
  });

  it('masks a bearer credential and the bearer header that carries it', () => {
    const bearer = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const mask = credentialEchoMaskerOf({ credential: bearer, authorization: `Bearer ${bearer}` });

    expect(mask(`x Bearer ${bearer} y`)).toBe(`x ${MARKER} y`);
  });

  it('leaves a text that holds no form of the credential as it was', () => {
    expect(maskOfJira()('Fix the login page for ada@example.com')).toBe('Fix the login page for ada@example.com');
  });

  it('does not mask the email half of an email:token credential: it is not the secret', () => {
    expect(maskOfJira()('assigned to ada@example.com')).toBe('assigned to ada@example.com');
  });

  it('masks every occurrence', () => {
    expect(maskOfJira()(`${TOKEN} and ${TOKEN}`)).toBe(`${MARKER} and ${MARKER}`);
  });

  it('masks a credential that has no colon without looking for a token half', () => {
    const mask = credentialEchoMaskerOf({ credential: 'abcdefghijkl', authorization: 'Bearer abcdefghijkl' });

    expect(mask('abcdefghijkl')).toBe(MARKER);
  });

  it('ignores a half of the credential that is too short to mask without destroying the text', () => {
    const mask = credentialEchoMaskerOf({ credential: 'ada@example.com:short', authorization: 'Basic x' });

    expect(mask('this is short and stays')).toBe('this is short and stays');
  });
});
