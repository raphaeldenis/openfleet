import type { DiagnosticsDocument } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectedDaemonRecord } from '../core/diagnostics-export';
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
const A_PROJECTED_RECORD: ProjectedDaemonRecord = { ts: '2026-10-04T09:00:00Z', level: 'warn', event: 'daemon_line', fields: { msg: 'ws_write_failed', extra_fields: '0' } };
const projectingEachRecordAs = (projected: ProjectedDaemonRecord) => vi.fn((records: unknown[]) => Promise.resolve(records.map(() => projected)));

const FRAGMENTS_OF_TOKEN_SHAPES = [['gh', 'p_'], ['s', 'k-ant-api03-'], ['AK', 'IA'], ['ey', 'J']];
const TOKEN_BODY = 'Q7f3Kx9LmZp2Rt8VwYb4Nc6Hd1Js5Ga0';
const hostileTokens = (): string[] => FRAGMENTS_OF_TOKEN_SHAPES.map((fragments) => `${fragments.join('')}${TOKEN_BODY}`);
const WINDOW_LENGTH = 12;
const windowsOf = (text: string): string[] => Array.from({ length: text.length - WINDOW_LENGTH + 1 }, (_, start) => text.slice(start, start + WINDOW_LENGTH));
const SIXTEEN_KIB = 16 * 1024;
const SIXTY_FOUR_KIB = 64 * 1024;

/** A ring buffer whose tokens sit in free text, in nested fields, just past the 16 KiB and 64 KiB bounds and in an element after the cut. */
function hostileRingBuffer(tokens: string[]): unknown[] {
  const [first, second, third, fourth] = tokens as [string, string, string, string];
  return [
    { level: 'error', msg: `login failed with ${first}`, err: { name: 'Error', message: second, stack: `Error: ${third}\n    at x (/Users/me/${fourth}.js:1:1)`, cause: { message: first } } },
    { level: 'info', msg: 'x', detail: { token: second, nested: [{ deeper: third }] }, [fourth]: first },
    `${' '.repeat(SIXTEEN_KIB - 1)}${first}`,
    { level: 'info', msg: `${'a'.repeat(SIXTEEN_KIB)} Authorization: Bearer ${second}` },
    `${'b'.repeat(SIXTY_FOUR_KIB)}${third}`,
    { level: 'info', msg: 'x', items: ['c'.repeat(SIXTY_FOUR_KIB), fourth] },
    `plain text ${fourth}`,
  ];
}

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

  it('zips the allowlisted daemon document and the desktop log, and nothing else', async () => {
    const { bytes, fileName } = await buildBundle({ daemonDocument: A_DOCUMENT, desktopLog: 'line one\nline two', at: AT, projectDaemonRecords: projectingEachRecordAs(A_PROJECTED_RECORD) });

    const entries = readZip(bytes);
    expect(fileName).toBe('openfleet-diagnostics-2026-10-03-1412.zip');
    expect(entries.map((entry) => entry.name)).toEqual([DAEMON_DIAGNOSTICS_ENTRY, DESKTOP_LOG_ENTRY]);
    expect(JSON.parse(entries[0]!.text)).toEqual({ generatedAt: '2026-10-04T10:00:00.000Z', sessions: [], log: [] });
    expect(entries[1]!.text).toBe('line one\nline two');
    expect(entries.every((entry) => entry.crcMatches)).toBe(true);
  });

  it('hands the ring buffer to the projection and keeps only the projected records as the log', async () => {
    const ringBuffer = [{ level: 'warn', msg: 'ws: write failed' }, 'not json'];
    const projectDaemonRecords = projectingEachRecordAs(A_PROJECTED_RECORD);

    const { bytes } = await buildBundle({ daemonDocument: { ...A_DOCUMENT, log: ringBuffer }, desktopLog: '', at: AT, projectDaemonRecords });

    expect(projectDaemonRecords).toHaveBeenCalledWith(ringBuffer);
    expect(JSON.parse(readZip(bytes)[0]!.text).log).toEqual([A_PROJECTED_RECORD, A_PROJECTED_RECORD]);
  });

  it('projects an empty log when the daemon sends no ring buffer', async () => {
    const projectDaemonRecords = projectingEachRecordAs(A_PROJECTED_RECORD);

    await buildBundle({ daemonDocument: { ...A_DOCUMENT, log: 'garbage' } as unknown as DiagnosticsDocument, desktopLog: '', at: AT, projectDaemonRecords });

    expect(projectDaemonRecords).toHaveBeenCalledWith([]);
  });

  it('copies no window of a token from a hostile ring buffer or document into the bundle', async () => {
    const tokens = hostileTokens();
    const hostileDocument = { ...A_DOCUMENT, version: { openfleet: `1.2.3+${tokens[3]}`, node: tokens[0], platform: `dev-${tokens[1]}` }, sessions: [{ name: tokens[0], directory: tokens[1] }], db: { quickCheck: tokens[2], sizeBytes: 1 }, log: hostileRingBuffer(tokens) } as unknown as DiagnosticsDocument;

    const { bytes } = await buildBundle({ daemonDocument: hostileDocument, desktopLog: '', at: AT, projectDaemonRecords: projectingEachRecordAs(A_PROJECTED_RECORD) });

    const bundledDocumentText = readZip(bytes)[0]!.text;
    const leakedWindows = tokens.flatMap(windowsOf).filter((window) => bundledDocumentText.includes(window));
    expect(leakedWindows).toEqual([]);
  });

  it('labels sizes in B, KB and MB', () => {
    expect([sizeLabelOf(96), sizeLabelOf(412 * 1024), sizeLabelOf(1.8 * 1024 * 1024)]).toEqual(['96 B', '412 KB', '1.8 MB']);
  });
});
