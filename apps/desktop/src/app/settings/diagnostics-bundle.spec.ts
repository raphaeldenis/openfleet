import type { DiagnosticsDocument } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { buildBundle, bundleFileNameAt, DAEMON_DIAGNOSTICS_ENTRY, DESKTOP_LOG_ENTRY, sizeLabelOf } from './diagnostics-bundle';
import { crc32Of, zipOf } from './diagnostics-zip';

interface ReadEntry { name: string; text: string; crcMatches: boolean }

/** Reads the archive the way an unzip tool does: through the end-of-central-directory record, then each local file. */
function readZip(bytes: Uint8Array): ReadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  expect(view.getUint32(endAt, true)).toBe(0x06054b50);
  const entryCount = view.getUint16(endAt + 10, true);
  let directoryAt = view.getUint32(endAt + 16, true);
  const decoder = new TextDecoder();
  const entries: ReadEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    expect(view.getUint32(directoryAt, true)).toBe(0x02014b50);
    const crc = view.getUint32(directoryAt + 16, true);
    const size = view.getUint32(directoryAt + 24, true);
    const nameLength = view.getUint16(directoryAt + 28, true);
    const localAt = view.getUint32(directoryAt + 42, true);
    const name = decoder.decode(bytes.subarray(directoryAt + 46, directoryAt + 46 + nameLength));
    const localNameLength = view.getUint16(localAt + 26, true);
    const contentAt = localAt + 30 + localNameLength;
    const content = bytes.subarray(contentAt, contentAt + size);
    entries.push({ name, text: decoder.decode(content), crcMatches: crc32Of(content) === crc });
    directoryAt += 46 + nameLength;
  }
  return entries;
}

const A_DOCUMENT = { generatedAt: '2026-10-04T10:00:00.000Z', log: [], sessions: [] } as unknown as DiagnosticsDocument;
const AT = new Date(2026, 9, 3, 14, 12, 7);

describe('the diagnostics zip', () => {
  it('computes the standard CRC-32 of "123456789"', () => {
    expect(crc32Of(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('holds every entry readable back with its name, content and a matching checksum, accents included', () => {
    const archive = zipOf([{ name: 'a.txt', text: 'héllo' }, { name: 'dir/b.log', text: '' }], AT);

    expect(readZip(archive)).toEqual([
      { name: 'a.txt', text: 'héllo', crcMatches: true },
      { name: 'dir/b.log', text: '', crcMatches: true },
    ]);
  });
});

describe('the diagnostics bundle', () => {
  it('names the file by the local date and minute', () => {
    expect(bundleFileNameAt(AT)).toBe('openfleet-diagnostics-2026-10-03-1412.zip');
  });

  it('zips the daemon document and the desktop log, and nothing else', () => {
    const { bytes, fileName } = buildBundle({ daemonDocument: A_DOCUMENT, desktopLog: 'line one\nline two', at: AT });

    const entries = readZip(bytes);
    expect(fileName).toBe('openfleet-diagnostics-2026-10-03-1412.zip');
    expect(entries.map((entry) => entry.name)).toEqual([DAEMON_DIAGNOSTICS_ENTRY, DESKTOP_LOG_ENTRY]);
    expect(JSON.parse(entries[0]!.text)).toEqual(A_DOCUMENT);
    expect(entries[1]!.text).toBe('line one\nline two');
    expect(entries.every((entry) => entry.crcMatches)).toBe(true);
  });

  it('labels sizes in B, KB and MB', () => {
    expect([sizeLabelOf(96), sizeLabelOf(412 * 1024), sizeLabelOf(1.8 * 1024 * 1024)]).toEqual(['96 B', '412 KB', '1.8 MB']);
  });
});
