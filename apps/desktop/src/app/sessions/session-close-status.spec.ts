import { describe, expect, it } from 'vitest';
import { closeStatusFor, exitCodeLabel } from './session-close-status';

const SIGTERM_EXIT_CODE = 143;
const SIGKILL_EXIT_CODE = 137;

describe('the close status of an exit code', () => {
  it.each([
    { label: 'a clean exit', exitCode: 0, kind: 'clean' },
    { label: 'a SIGTERM death (user close, parent close, daemon shutdown)', exitCode: SIGTERM_EXIT_CODE, kind: 'clean' },
    { label: 'a SIGKILL death of a hung CLI', exitCode: SIGKILL_EXIT_CODE, kind: 'failed' },
    { label: 'a plain failure', exitCode: 1, kind: 'failed' },
    { label: 'no exit code', exitCode: undefined, kind: 'unknown' },
  ] as const)('is $kind for $label', ({ exitCode, kind }) => {
    expect(closeStatusFor(exitCode).kind).toBe(kind);
  });

  it.each([
    { exitCode: 0, label: 'closed · exit 0' },
    { exitCode: 1, label: 'closed · exit 1' },
    { exitCode: undefined, label: 'closed' },
  ])('is labelled "$label" for exit code $exitCode', ({ exitCode, label }) => {
    expect(exitCodeLabel(exitCode)).toBe(label);
  });
});
