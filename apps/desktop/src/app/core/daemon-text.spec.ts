import { describe, expect, it } from 'vitest';
import { readableDaemonText } from './daemon-text';

const SYNTHETIC_BEARER_TOKEN = 'SYNTHETIC_TOKEN_123';
const SYNTHETIC_CREDENTIALS = {
  'a bearer token': `Authorization: Bearer ${SYNTHETIC_BEARER_TOKEN}`,
  'an sk- key': 'key sk-ant-SYNTHETIC0123456789ABCD',
  'a GitHub token': 'token ghp_SYNTHETIC0123456789abcdefghij',
  'an AWS access key id': 'id AKIASYNTHETIC1234567',
  'a JWT': 'jwt eyJSYNTHETICheader.eyJSYNTHETICpayload.signature-part',
  'a hook url': 'POST /hooks/SYNTHETICHOOKTOKEN123/stop',
};

describe('readableDaemonText', () => {
  it.each(Object.entries(SYNTHETIC_CREDENTIALS))('masks %s', (_label, text) => {
    const readable = readableDaemonText(text);

    expect(readable).toContain('***');
    expect(readable).not.toMatch(/SYNTHETIC/);
  });

  it('keeps the words around a masked bearer token', () => {
    expect(readableDaemonText(`Authorization: Bearer ${SYNTHETIC_BEARER_TOKEN}; safe`)).toBe('Authorization: Bearer ***; safe');
  });

  it.each([
    ['a macOS home', 'open /Users/review-user/private/project now', 'open ~/private/project now'],
    ['a Linux home', 'open /home/review-user/private/project now', 'open ~/private/project now'],
    ['a bare home', 'open /Users/review-user', 'open ~'],
  ])('shortens %s to ~', (_label, text, expected) => {
    expect(readableDaemonText(text)).toBe(expected);
  });

  it('shows bidirectional, zero-width and isolate characters as escapes', () => {
    expect(readableDaemonText('safe‮evil​ hint⁦hidden⁩')).toBe('safe<U+202E>evil<U+200B> hint<U+2066>hidden<U+2069>');
  });

  it('still masks a token that hides a zero-width character inside', () => {
    const readable = readableDaemonText(`Bearer SYNTHETIC​_TOKEN_123 tail`);

    expect(readable).not.toContain('SYNTHETIC');
    expect(readable).not.toContain('TOKEN_123');
  });

  it('leaves an ordinary sentence untouched', () => {
    expect(readableDaemonText('The vault is locked. Unlock it first.')).toBe('The vault is locked. Unlock it first.');
  });
});
