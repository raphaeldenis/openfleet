import { describe, expect, it } from 'vitest';
import { evaluateGateStep } from './gateStep.js';

const REPORT = '12 passed';

describe('evaluateGateStep', () => {
  it('passes a command that exits 0 and prints a report', () => {
    expect(evaluateGateStep({ exitCode: 0, notFound: false, stdout: REPORT })).toEqual({ isPass: true });
  });

  it('fails a command that is not found, whatever else it reports', () => {
    expect(evaluateGateStep({ exitCode: 0, notFound: true, stdout: REPORT })).toEqual({ isPass: false, reason: 'command_not_found' });
  });

  it('fails a command that has no exit code, such as one killed by a signal', () => {
    expect(evaluateGateStep({ exitCode: null, notFound: false, stdout: REPORT })).toEqual({ isPass: false, reason: 'no_exit_code' });
  });

  it('fails a command that exits non-zero and names the code', () => {
    expect(evaluateGateStep({ exitCode: 2, notFound: false, stdout: REPORT })).toEqual({ isPass: false, reason: 'non_zero_exit', exitCode: 2 });
  });

  it.each([['nothing', ''], ['only whitespace', ' \n\t']])('fails a command that prints %s', (_name, stdout) => {
    expect(evaluateGateStep({ exitCode: 0, notFound: false, stdout })).toEqual({ isPass: false, reason: 'empty_output' });
  });

  it('fails a report that the caller cannot parse', () => {
    const isReportParsable = (stdout: string) => stdout.startsWith('{');
    expect(evaluateGateStep({ exitCode: 0, notFound: false, stdout: 'garbled', isReportParsable })).toEqual({ isPass: false, reason: 'unparsable_report' });
  });

  it('passes a report that the caller parses', () => {
    const isReportParsable = (stdout: string) => stdout.startsWith('{');
    expect(evaluateGateStep({ exitCode: 0, notFound: false, stdout: '{"passed":12}', isReportParsable })).toEqual({ isPass: true });
  });

  it.each([
    ['a promise', () => Promise.resolve(false)],
    ['the string ok', () => 'ok'],
    ['the number 1', () => 1],
    ['undefined', () => undefined],
    ['null', () => null],
  ])('fails a report whose parser returns %s instead of true', (_name, parser) => {
    const isReportParsable = parser as unknown as (stdout: string) => boolean;
    expect(evaluateGateStep({ exitCode: 0, notFound: false, stdout: REPORT, isReportParsable })).toEqual({ isPass: false, reason: 'unparsable_report' });
  });

  it.each([
    ['a zero width space', '​'],
    ['a word joiner', '⁠'],
    ['a braille blank', '⠀'],
    ['a byte order mark', '﻿'],
    ['a soft hyphen', '­'],
    ['a no-break space', ' '],
  ])('fails a command that prints only %s', (_name, stdout) => {
    expect(evaluateGateStep({ exitCode: 0, notFound: false, stdout })).toEqual({ isPass: false, reason: 'empty_output' });
  });

  it('fails closed when the stdout is undefined', () => {
    const stdout = undefined as unknown as string;
    expect(evaluateGateStep({ exitCode: 0, notFound: false, stdout })).toEqual({ isPass: false, reason: 'empty_output' });
  });

  it('fails a report whose parser throws', () => {
    const isReportParsable = () => { throw new Error('boom'); };
    expect(evaluateGateStep({ exitCode: 0, notFound: false, stdout: REPORT, isReportParsable })).toEqual({ isPass: false, reason: 'unparsable_report' });
  });
});
