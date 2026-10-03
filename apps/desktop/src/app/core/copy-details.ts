import { readableDaemonText } from './daemon-text';

export interface ProblemDetails {
  ref?: string;
  code: string;
  message?: string;
  at: string;
  daemonVersion?: string | null;
  appVersion?: string | null;
  address?: string;
}

/** The text a user pastes into a bug report: the ref, the code, the message, the daemon and app versions, the daemon address and the time, and nothing else. Lines without a value are left out. Daemon words go through `readableDaemonText`. */
export function detailsTextOf({ ref, code, message, at, daemonVersion, appVersion, address }: ProblemDetails): string {
  const lines = [
    ref ? `ref ${readableDaemonText(ref)}` : undefined,
    `code: ${readableDaemonText(code)}`,
    message ? `message: ${readableDaemonText(message)}` : undefined,
    daemonVersion ? `daemon: ${readableDaemonText(daemonVersion)}` : undefined,
    appVersion ? `app: ${readableDaemonText(appVersion)}` : undefined,
    address ? `address: ${address}` : undefined,
    `time: ${at}`,
  ];
  return lines.filter((line): line is string => line !== undefined).join('\n');
}
