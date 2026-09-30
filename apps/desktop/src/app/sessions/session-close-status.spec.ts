import { describe, expect, it } from 'vitest';
import { closedStripCopyFor } from './session-close-status';

const SIGTERM_EXIT_CODE = 143;
const SIGKILL_EXIT_CODE = 137;

describe('the strip a closed session shows', () => {
  it.each([
    { label: 'a clean exit', exitCode: 0 },
    { label: 'a SIGTERM death (user close, parent close, daemon shutdown)', exitCode: SIGTERM_EXIT_CODE },
  ])('is neutral for $label', ({ exitCode }) => {
    const strip = closedStripCopyFor(exitCode);

    expect(strip.variant).toBe('neutral');
    expect(strip.description).not.toContain('exited with an error');
  });

  it.each([
    { label: 'a SIGKILL death of a hung CLI', exitCode: SIGKILL_EXIT_CODE },
    { label: 'a plain failure', exitCode: 1 },
  ])('is an error for $label', ({ exitCode }) => {
    const strip = closedStripCopyFor(exitCode);

    expect(strip).toMatchObject({ variant: 'error', title: `■ Closed · exit ${exitCode}` });
  });
});
