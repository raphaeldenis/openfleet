import { readableDaemonText } from './daemon-text';

export interface ProblemDetails {
  ref?: string;
  code: string;
  message: string;
  at: string;
  daemonVersion?: string | null;
}

/** The text a user pastes into a bug report: the ref, the code, the message, the daemon version and the time, and nothing else. Daemon words go through `readableDaemonText`. */
export function detailsTextOf({ ref, code, message, at, daemonVersion }: ProblemDetails): string {
  const lines = [
    ref ? `ref ${readableDaemonText(ref)}` : undefined,
    `code: ${readableDaemonText(code)}`,
    `message: ${readableDaemonText(message)}`,
    daemonVersion ? `daemon: ${readableDaemonText(daemonVersion)}` : undefined,
    `time: ${at}`,
  ];
  return lines.filter((line): line is string => line !== undefined).join('\n');
}
