import type { DiagnosticsDocument } from '@openfleet/shared';
import { zipOf } from './diagnostics-zip';

export const DAEMON_DIAGNOSTICS_ENTRY = 'daemon-diagnostics.json';
export const DESKTOP_LOG_ENTRY = 'desktop.log';

export interface DiagnosticsBundle {
  fileName: string;
  bytes: Uint8Array;
}

const twoDigits = (value: number): string => String(value).padStart(2, '0');

/** `openfleet-diagnostics-2026-10-03-1412.zip`, in the user's local time. */
export function bundleFileNameAt(moment: Date): string {
  const day = `${moment.getFullYear()}-${twoDigits(moment.getMonth() + 1)}-${twoDigits(moment.getDate())}`;
  return `openfleet-diagnostics-${day}-${twoDigits(moment.getHours())}${twoDigits(moment.getMinutes())}.zip`;
}

/** Zips the daemon's document and the desktop log: nothing else goes in. */
export function buildBundle({ daemonDocument, desktopLog, at }: { daemonDocument: DiagnosticsDocument; desktopLog: string; at: Date }): DiagnosticsBundle {
  const entries = [
    { name: DAEMON_DIAGNOSTICS_ENTRY, text: JSON.stringify(daemonDocument, null, 2) },
    { name: DESKTOP_LOG_ENTRY, text: desktopLog },
  ];
  return { fileName: bundleFileNameAt(at), bytes: zipOf(entries, at) };
}

const BYTES_PER_KILOBYTE = 1024;
const BYTES_PER_MEGABYTE = BYTES_PER_KILOBYTE * 1024;

/** `1.8 MB`, `412 KB`, `96 B`. */
export function sizeLabelOf(byteCount: number): string {
  if (byteCount >= BYTES_PER_MEGABYTE) return `${(byteCount / BYTES_PER_MEGABYTE).toFixed(1)} MB`;
  if (byteCount >= BYTES_PER_KILOBYTE) return `${Math.round(byteCount / BYTES_PER_KILOBYTE)} KB`;
  return `${byteCount} B`;
}
