import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_KINDS, HTTP_STATUS_BY_KIND, OpenFleetError, RETRY_BY_KIND, isErrorEnvelope, retryOf, type ErrorCode } from './errors.js';

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

  it('files constraint_violation under invalid_request: a bad cell value is the caller\'s row (decision D10)', () => {
    expect(ERROR_CODES.constraint_violation.kind).toBe('invalid_request');
  });
});

describe('the wire contract of the registry', () => {
  const KIND_AND_RETRY_BY_CODE: Record<ErrorCode, string> = {
    invalid_body: 'invalid_request/never', invalid_json: 'invalid_request/never', invalid_url: 'invalid_request/never', invalid_branch_name: 'invalid_request/never', unknown_harness: 'invalid_request/never',
    constraint_violation: 'invalid_request/never', message_held_for_review: 'invalid_request/never', message_too_long: 'invalid_request/never', query_too_long: 'invalid_request/never', outside_own_repository: 'invalid_request/never',
    unauthorized: 'unauthorized/never',
    not_found: 'not_found/never', project_not_found: 'not_found/never', no_state: 'not_found/never', session_not_found: 'not_found/never',
    note_not_found: 'not_found/never', store_not_found: 'not_found/never', view_not_found: 'not_found/never', row_not_found: 'not_found/never',
    manager_not_found: 'not_found/never',
    session_closed: 'conflict/never', stale_revision: 'conflict/after_refresh', file_backed: 'conflict/never', file_unreadable: 'conflict/later',
    path_escapes_docs_folder: 'conflict/never', duplicate_name: 'conflict/never', worktree_exists: 'conflict/never',
    not_closed: 'conflict/never', directory_missing: 'conflict/never', directory_changed: 'conflict/never',
    directory_unreadable: 'conflict/never', already_resolved: 'conflict/never', config_unreadable: 'conflict/never',
    config_read_only: 'conflict/never', message_id_reused: 'conflict/never', too_many_pending: 'conflict/later', children_cap: 'conflict/later',
    outside_lineage: 'conflict/never', not_a_manager: 'conflict/never', directory_in_use: 'conflict/never',
    duplicate_child: 'conflict/never', no_parent: 'conflict/never', spawn_raced: 'conflict/later',
    store_has_rows: 'conflict/never', duplicate_id: 'conflict/never', no_docs_folder: 'conflict/never', not_file_backed: 'conflict/never',
    docs_folder_not_writable: 'conflict/later', handoff_not_found: 'not_found/never',
    payload_too_large: 'too_large/never', note_too_large: 'too_large/never', row_cap: 'too_large/never', state_too_large: 'too_large/never',
    daemon_shutting_down: 'unavailable/later', daemon_degraded: 'unavailable/later', delivery_failed: 'unavailable/later', harness_exited: 'unavailable/never',
    claude_not_found: 'unavailable/never', git_unavailable: 'unavailable/never',
    internal_error: 'internal/later', launch_failed: 'internal/later', resume_timeout: 'internal/later', db_stuck: 'internal/later',
  };

  it('gives every code the kind and the retry the spec lists', () => {
    const actual = Object.fromEntries(allCodes.map((code) => [code, `${ERROR_CODES[code].kind}/${retryOf(code)}`]));

    expect(actual).toEqual(KIND_AND_RETRY_BY_CODE);
  });

  it('answers each kind with the http status the desktop and the agents read', () => {
    expect(HTTP_STATUS_BY_KIND).toEqual({
      invalid_request: 400, unauthorized: 401, not_found: 404, conflict: 409, too_large: 413, unavailable: 503, internal: 500,
    });
  });

  it('gives each kind the default retry the spec lists', () => {
    expect(RETRY_BY_KIND).toEqual({
      invalid_request: 'never', unauthorized: 'never', not_found: 'never', conflict: 'after_refresh', too_large: 'never', unavailable: 'later', internal: 'later',
    });
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
