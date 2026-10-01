import { ERROR_CODES, HTTP_STATUS_BY_KIND, retryOf, type DaemonIssue, type ErrorCode, type ErrorEnvelope } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from './fleet-api.service';
import { copyFor, copyOfDaemonIssue, copyOfEnvelope, retryOfError } from './error-copy';

const ALL_CODES = Object.keys(ERROR_CODES) as ErrorCode[];

function envelopeOf(code: ErrorCode, patch: Partial<ErrorEnvelope> = {}): ErrorEnvelope {
  return { error: code, kind: ERROR_CODES[code].kind, retry: retryOf(code), message: 'raw daemon message', ...patch };
}

function apiErrorOf(envelope: ErrorEnvelope): ApiError {
  return new ApiError(HTTP_STATUS_BY_KIND[envelope.kind], 'GET /x', envelope.error, envelope);
}

describe('copyFor', () => {
  describe.each(ALL_CODES)('the code %s', (code) => {
    const envelope = envelopeOf(code, code === 'internal_error' ? { id: '3f9a1c2e' } : {});
    const { text } = copyFor(apiErrorOf(envelope), { action: 'generic' });

    it('reads as a sentence: ends with a period and names no code', () => {
      const isInternal = envelope.kind === 'internal';
      const sentence = isInternal ? text.replace(/ \(ref [0-9a-f]{8}\)$/, '') : text;
      expect(sentence.endsWith('.')).toBe(true);
      expect(text).not.toContain('_');
    });

    it('never leaks the daemon message or a status number', () => {
      expect(text).not.toContain('raw daemon message');
      expect(text).not.toMatch(/\b[45]\d\d\b/);
    });

    it('says "try again" exactly when a retry can help', () => {
      const canRetry = envelope.retry !== 'never';
      expect(/try again/i.test(text)).toBe(canRetry);
    });
  });

  it('appends the ref of an internal error and returns it apart', () => {
    const envelope = envelopeOf('internal_error', { id: '3f9a1c2e' });

    const copy = copyFor(apiErrorOf(envelope), { action: 'generic' });

    expect(copy.text.endsWith('(ref 3f9a1c2e)')).toBe(true);
    expect(copy.ref).toBe('3f9a1c2e');
  });

  it('gives a message_held_for_review copy that tells the user to resend without invisible characters', () => {
    const { text } = copyFor(apiErrorOf(envelopeOf('message_held_for_review')), { action: 'send' });

    expect(text).toMatch(/invisible characters/i);
    expect(text).not.toMatch(/try again/i);
  });

  it('prefers the entry of the action over the entry of the code', () => {
    const envelope = envelopeOf('payload_too_large');

    expect(copyFor(apiErrorOf(envelope), { action: 'create_session' }).text).toContain('shorten the directory or the name');
    expect(copyFor(apiErrorOf(envelope), { action: 'create_manager' }).text).toContain('shorten the mission');
  });

  it('tells a lost connection apart from a daemon answer', () => {
    const { text } = copyFor(new TypeError('Failed to fetch'), { action: 'generic' });

    expect(text).toMatch(/can.t reach the OpenFleet daemon/i);
  });

  it('falls back to the daemon message and hint for a code from a newer daemon', () => {
    const newer = { error: 'brand_new_code', kind: 'conflict', retry: 'never', message: 'The vault is locked', hint: 'unlock it first.' } as unknown as ErrorEnvelope;

    const { text } = copyFor(apiErrorOf(newer), { action: 'generic' });

    expect(text).toBe('The vault is locked. Unlock it first.');
  });

  it('falls back by kind for an unknown code without an envelope', () => {
    const { text } = copyFor(new ApiError(503, 'GET /x', 'brand_new_code'), { action: 'generic' });

    expect(text).toMatch(/try again/i);
  });

  it('adds no ref to an envelope that is not internal, even when it carries an id', () => {
    const envelope = envelopeOf('harness_exited', { id: '3f9a1c2e' });

    const copy = copyFor(apiErrorOf(envelope), { action: 'generic' });

    expect(copy.text).not.toContain('ref');
    expect(copy.ref).toBeUndefined();
  });

  it('follows the retry hint of the envelope rather than the one of the registry', () => {
    const retriableRejection = envelopeOf('invalid_body', { retry: 'later' });
    const finalInternalError = envelopeOf('internal_error', { retry: 'never', id: '3f9a1c2e' });

    expect(copyFor(apiErrorOf(retriableRejection), { action: 'generic' }).text).toMatch(/try again/i);
    expect(copyFor(apiErrorOf(finalInternalError), { action: 'generic' }).text).not.toMatch(/try again/i);
  });

  describe('copyOfEnvelope', () => {
    it('reads an envelope that came on the websocket exactly like the same envelope from a response', () => {
      const envelope = envelopeOf('launch_failed', { id: '3f9a1c2e' });

      expect(copyOfEnvelope(envelope, { action: 'generic' })).toEqual(copyFor(apiErrorOf(envelope), { action: 'generic' }));
    });
  });

  describe('loading the todos', () => {
    it('says it cannot load the todos and invites a retry when the failure can pass', () => {
      expect(copyFor(new ApiError(502, 'GET /x'), { action: 'load_todos' }).text).toBe("Can't load the todos — try again.");
    });

    it('says it cannot load the todos without inviting a retry when it cannot pass', () => {
      expect(copyFor(new ApiError(200, 'GET /x'), { action: 'load_todos' }).text).toBe("Can't load the todos.");
    });
  });

  describe('retryOfError', () => {
    it('reads the retry hint of the envelope', () => {
      expect(retryOfError(apiErrorOf(envelopeOf('internal_error', { retry: 'never' })))).toBe('never');
    });

    it('reads the retry of a known code that came without an envelope', () => {
      expect(retryOfError(new ApiError(404, 'GET /x', 'not_found'))).toBe('never');
    });

    it('says a request that got no answer is worth retrying', () => {
      expect(retryOfError(new TypeError('Failed to fetch'))).toBe('later');
    });
  });

  describe('copyOfDaemonIssue', () => {
    const issueOf = (code: DaemonIssue['code']): DaemonIssue => ({ code, since: '2026-09-30T10:00:00.000Z', message: 'Something broke.', id: '3f9a1c2e', count: 1 });

    it.each(['uncaught_exception', 'db_stuck'] as const)('asks for a restart when %s does not clear by itself', (code) => {
      expect(copyOfDaemonIssue(issueOf(code))).toBe('Something broke — restart it when convenient');
    });

    it.each(['hook_fail_open', 'ws_broadcast_failed', 'docs_folder_unreadable'] as const)('says %s may clear by itself', (code) => {
      expect(copyOfDaemonIssue(issueOf(code))).toBe('Something broke — it may clear by itself');
    });
  });
});
