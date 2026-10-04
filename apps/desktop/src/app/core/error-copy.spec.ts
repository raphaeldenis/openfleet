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

  it('tells the user to fix the folder permissions, then try again, when the docs folder is not writable', () => {
    const { text } = copyFor(apiErrorOf(envelopeOf('docs_folder_not_writable')), { action: 'generic' });

    expect(text).toBe('The docs folder is not writable — fix the folder permissions, then try again.');
  });

  it('tells the user to pick another handoff, without a retry, when the handoff is gone', () => {
    const { text } = copyFor(apiErrorOf(envelopeOf('handoff_not_found')), { action: 'create_session' });

    expect(text).toBe('That handoff is no longer in the docs folder — pick another handoff or remove it.');
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

  it('masks credentials, shortens home paths and shows invisible characters in the message and the hint of a code from a newer daemon', () => {
    const hostile = {
      error: 'future_failure', kind: 'internal', retry: 'never', id: 'c0ffee01',
      message: 'open /Users/review-user/private/project; Authorization: Bearer SYNTHETIC_TOKEN_123; safe‮evil​',
      hint: 'hint⁦hidden⁩ see /home/review-user/notes',
    } as unknown as ErrorEnvelope;

    const { text } = copyFor(apiErrorOf(hostile), { action: 'generic' });

    expect(text).toBe('Open ~/private/project; Authorization: Bearer ***; safe<U+202E>evil<U+200B>. Hint<U+2066>hidden<U+2069> see ~/notes. (ref c0ffee01)');
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

  describe('the retry of the envelope decides the ending of every action', () => {
    const ACTIONS = ['generic', 'send', 'create_session', 'create_manager', 'resume', 'rename', 'close', 'load_handoff', 'save_handoff', 'save_project'] as const;
    const RETRIES = ['never', 'later', 'after_refresh'] as const;
    const wordsOfEnvelope = (code: ErrorCode, retry: ErrorEnvelope['retry'], action: (typeof ACTIONS)[number]) => {
      const envelope = envelopeOf(code, { retry, ...(ERROR_CODES[code].kind === 'internal' && { id: '3f9a1c2e' }) });
      return copyFor(apiErrorOf(envelope), { action }).text.replace(/ \(ref [0-9a-f]{8}\)$/, '');
    };
    const violationsOf = (action: (typeof ACTIONS)[number], retry: ErrorEnvelope['retry']) =>
      ALL_CODES.flatMap((code) => {
        const text = wordsOfEnvelope(code, retry, action);
        const invitesRetry = /try again/i.test(text);
        const invitesReload = /reload|refresh/i.test(text);
        const problems = [
          invitesRetry !== (retry !== 'never') && `${retry === 'never' ? 'invites' : 'omits'} a retry`,
          invitesReload !== (retry === 'after_refresh') && `${retry === 'after_refresh' ? 'omits' : 'invites'} a reload`,
        ].filter(Boolean);
        return problems.map((problem) => `${code}: ${problem} — "${text}"`);
      });

    it('covers every code, action and retry once (1890 cases)', () => {
      expect(ALL_CODES.length * ACTIONS.length * RETRIES.length).toBe(1890);
    });

    describe.each(ACTIONS)('the action %s', (action) => {
      it.each(RETRIES)('invites a retry exactly when the envelope retry is not never, and a reload exactly for after_refresh (envelope retry %s)', (retry) => {
        expect(violationsOf(action, retry)).toEqual([]);
      });
    });

    it('does not invite a retry that an internal error of the envelope forbids while creating a session', () => {
      const envelope = envelopeOf('internal_error', { retry: 'never', id: '3f9a1c2e' });

      expect(copyFor(apiErrorOf(envelope), { action: 'create_session' }).text).toBe('The daemon hit an internal error while creating the session. (ref 3f9a1c2e)');
    });

    it('tells to reload when the envelope says so, whatever the action says by default', () => {
      const envelope = envelopeOf('launch_failed', { retry: 'after_refresh', id: '3f9a1c2e' });

      expect(copyFor(apiErrorOf(envelope), { action: 'resume' }).text).toBe('The harness failed to relaunch — reload, then try again. (ref 3f9a1c2e)');
    });

    it('ends a retriable rejection of a creation with a retry', () => {
      const envelope = envelopeOf('invalid_body', { retry: 'later' });

      expect(copyFor(apiErrorOf(envelope), { action: 'create_manager' }).text).toBe('The daemon rejected these values — check the directory and the other fields, then try again.');
    });
  });

  describe('the handoff actions', () => {
    it('tells the user the folder is not writable when the handoff save is refused for it', () => {
      const { text } = copyFor(apiErrorOf(envelopeOf('docs_folder_not_writable')), { action: 'save_handoff' });

      expect(text).toBe('The handoff was not written: the docs folder is not writable — fix the folder permissions, then try again.');
    });

    it('tells the user the session is gone, without a retry, when the preview is asked for an unknown session', () => {
      const { text } = copyFor(apiErrorOf(envelopeOf('session_not_found')), { action: 'load_handoff' });

      expect(text).toBe('That session no longer exists.');
    });

    it('tells the user the handoff file is gone, without a retry', () => {
      const { text } = copyFor(apiErrorOf(envelopeOf('handoff_not_found')), { action: 'load_handoff' });

      expect(text).toBe('That handoff is no longer in the docs folder — pick another handoff or remove it.');
    });

    it('says the daemon did not answer in time when the preview could not be loaded and the daemon gives no reason', () => {
      const { text } = copyFor(new ApiError(500, 'GET /x'), { action: 'load_handoff' });

      expect(text).toBe('The preview could not be loaded — the daemon did not answer in time.');
    });

    it('says the handoff was not written when the daemon gives no reason', () => {
      const { text } = copyFor(new ApiError(500, 'POST /x'), { action: 'save_handoff' });

      expect(text).toBe('The handoff was not written — try again.');
    });

    it('asks to check the connection when the daemon cannot be reached while collecting the preview', () => {
      const { text } = copyFor(new TypeError('Failed to fetch'), { action: 'load_handoff' });

      expect(text).toBe('The preview could not be loaded — check your connection, then try again.');
    });

    it('asks to check the connection when the daemon cannot be reached while saving', () => {
      const { text } = copyFor(new TypeError('Failed to fetch'), { action: 'save_handoff' });

      expect(text).toBe('The handoff was not written — check your connection, then try again.');
    });
  });

  describe('the project actions', () => {
    const copyOfProjectFailure = (code: ErrorCode, retry: ErrorEnvelope['retry']) =>
      copyFor(apiErrorOf(envelopeOf(code, { retry })), { action: 'save_project' }).text;

    it('tells the user to use an existing absolute folder path when the daemon rejects the values and a retry cannot help', () => {
      expect(copyOfProjectFailure('invalid_body', 'never')).toBe('That folder cannot be used: use an existing absolute folder path.');
    });

    it('tells the user the folder is not writable, and to fix its permissions, then try again', () => {
      expect(copyOfProjectFailure('docs_folder_not_writable', 'later')).toBe('That folder is not writable — fix its permissions, then try again.');
    });

    it('tells the user a path inside the folder leaves it, without a retry', () => {
      expect(copyOfProjectFailure('path_escapes_docs_folder', 'never')).toBe('That folder contains a link that leads outside it — pick a folder without one.');
    });

    it('tells the user the project is gone when it was deleted meanwhile', () => {
      expect(copyOfProjectFailure('project_not_found', 'never')).toBe('That project no longer exists.');
    });

    it('says the project was not saved when the daemon gives no reason', () => {
      expect(copyFor(new ApiError(500, 'POST /x'), { action: 'save_project' }).text).toBe('The project was not saved — try again.');
    });

    it('asks to check the connection when the daemon cannot be reached', () => {
      expect(copyFor(new TypeError('Failed to fetch'), { action: 'save_project' }).text).toBe('The project was not saved — check your connection, then try again.');
    });
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

    it('masks credentials, shortens home paths and shows invisible characters in the message of the issue', () => {
      const hostile: DaemonIssue = { ...issueOf('db_stuck'), message: 'Cannot open /Users/review-user/db; Bearer SYNTHETIC_TOKEN_123; safe‮evil​.' };

      expect(copyOfDaemonIssue(hostile)).toBe('Cannot open ~/db; Bearer ***; safe<U+202E>evil<U+200B> — restart it when convenient');
    });
  });
});
