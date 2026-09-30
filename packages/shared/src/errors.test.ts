import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_KINDS, HTTP_STATUS_BY_KIND, OpenFleetError, RETRY_BY_KIND, isErrorEnvelope, type ErrorCode } from './errors.js';

const RETRIES = ['never', 'after_refresh', 'later'];
const allCodes = Object.keys(ERROR_CODES) as ErrorCode[];

describe('the error registry', () => {
  it.each(allCodes)('gives %s exactly one known kind', (code) => {
    expect(ERROR_KINDS).toContain(ERROR_CODES[code].kind);
  });

  it.each(allCodes)('gives %s a retry hint when it overrides its kind', (code) => {
    const { retry } = ERROR_CODES[code] as { retry?: string };
    if (retry !== undefined) expect(RETRIES).toContain(retry);
  });

  it.each(ERROR_KINDS)('gives the %s kind an http status and a retry', (kind) => {
    expect(HTTP_STATUS_BY_KIND[kind]).toBeGreaterThanOrEqual(400);
    expect(RETRIES).toContain(RETRY_BY_KIND[kind]);
  });

  it('keeps every code already on the wire', () => {
    const wireCodes = [
      'invalid_body', 'invalid_json', 'invalid_url', 'unknown_harness', 'constraint_violation', 'unauthorized', 'not_found', 'project_not_found', 'no_state',
      'session_closed', 'stale_revision', 'file_backed', 'file_unreadable', 'path_escapes_docs_folder', 'duplicate_name', 'not_closed', 'directory_missing',
      'directory_changed', 'directory_unreadable', 'already_resolved', 'config_unreadable', 'config_read_only', 'payload_too_large', 'note_too_large', 'row_cap',
      'daemon_shutting_down', 'internal_error', 'launch_failed',
    ];
    expect(allCodes).toEqual(expect.arrayContaining(wireCodes));
  });

  // D10 (constraint_violation 409 -> 400) is pending: the registry keeps today's 409 until it is decided.
  it('keeps constraint_violation a conflict until decision D10 moves it to invalid_request', () => {
    expect(ERROR_CODES.constraint_violation.kind).toBe('conflict');
  });
});

describe('OpenFleetError', () => {
  it('derives its kind from the registry', () => {
    const error = new OpenFleetError('row_cap', 'the store is full.');
    expect(error.kind).toBe('too_large');
  });

  it('carries its code, hint and cause', () => {
    const cause = new Error('root');
    const error = new OpenFleetError('stale_revision', 'the note moved.', { hint: 'reload it', cause });
    expect({ code: error.code, message: error.message, hint: error.options.hint, cause: error.cause }).toEqual({
      code: 'stale_revision', message: 'the note moved.', hint: 'reload it', cause,
    });
  });
});

describe('isErrorEnvelope', () => {
  const envelope = { error: 'not_found', kind: 'not_found', retry: 'never', message: 'gone.' };

  it('accepts a complete envelope', () => {
    expect(isErrorEnvelope(envelope)).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'not_found'],
    ['a legacy body without kind', { error: 'not_found' }],
    ['an unknown kind', { ...envelope, kind: 'weird' }],
    ['an unknown retry', { ...envelope, retry: 'sometimes' }],
    ['a non-string message', { ...envelope, message: 4 }],
  ])('rejects %s', (_label, value) => {
    expect(isErrorEnvelope(value)).toBe(false);
  });
});
