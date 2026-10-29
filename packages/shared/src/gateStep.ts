import { isBlankText } from './isBlankText.js';

export interface GateStepOutcome {
  /** The exit code of the command, or null when it has none (killed by a signal, never started). */
  exitCode: number | null;
  notFound: boolean;
  stdout: string;
  /** Tells whether the report the command printed can be read; a parser that throws counts as unreadable. */
  isReportParsable?: (stdout: string) => boolean;
}

export type GateStepVerdict =
  | { isPass: true }
  | { isPass: false; reason: 'command_not_found' | 'cwd_not_found' | 'no_exit_code' | 'empty_output' | 'unparsable_report' }
  | { isPass: false; reason: 'non_zero_exit'; exitCode: number };

const SUCCESS_EXIT_CODE = 0;

function isParsable({ isReportParsable, stdout }: Pick<GateStepOutcome, 'isReportParsable' | 'stdout'>): boolean {
  if (isReportParsable === undefined) return true;
  try {
    const answer: unknown = isReportParsable(stdout);
    return answer === true;
  } catch {
    return false;
  }
}

/** A gate step passes only when its command was found, exited 0, printed a report and the report can be read; every other outcome fails. */
export function evaluateGateStep(outcome: GateStepOutcome): GateStepVerdict {
  const { exitCode, notFound, stdout } = outcome;
  if (notFound) return { isPass: false, reason: 'command_not_found' };
  if (exitCode === null) return { isPass: false, reason: 'no_exit_code' };
  if (exitCode !== SUCCESS_EXIT_CODE) return { isPass: false, reason: 'non_zero_exit', exitCode };
  if (typeof stdout !== 'string' || isBlankText(stdout)) return { isPass: false, reason: 'empty_output' };
  if (!isParsable(outcome)) return { isPass: false, reason: 'unparsable_report' };
  return { isPass: true };
}
