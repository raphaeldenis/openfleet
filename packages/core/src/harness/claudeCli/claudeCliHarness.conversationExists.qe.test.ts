import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

const conversationId = '44444444-4444-4444-8444-444444444444';
const FOUR_MEGABYTES = 4 * 1024 * 1024;
const BOM = '﻿';
const titleOnlyStub = '{"type":"custom-title","customTitle":"x","sessionId":"s"}\n';
const userLine = '{"type":"user","message":{"role":"user","content":"hello"}}\n';

const systemLineOfBytes = (byteCount: number) => {
  const frame = '{"type":"system","note":""}\n';
  return `{"type":"system","note":"${'x'.repeat(byteCount - frame.length)}"}\n`;
};

describe('QE: a transcript whose first bytes or size are unusual', () => {
  let configDir: string;
  let sessionDirectory: string;
  let previousConfigDir: string | undefined;

  const conversationExists = async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    return new ClaudeCliHarness(join(configDir, 'sessions')).conversationExists({ cliSessionId: conversationId, directory: sessionDirectory });
  };

  const writeTranscript = (content: string | Buffer) => {
    const projectDirectory = join(configDir, 'projects', realpathSync(sessionDirectory).replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(join(projectDirectory, `${conversationId}.jsonl`), content);
  };

  beforeEach(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'of-claude-config-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    sessionDirectory = mkdtempSync(join(tmpdir(), 'of-cwd-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  });

  it('sees the conversation present when the byte order mark opens a stub and a user line follows', async () => {
    writeTranscript(BOM + titleOnlyStub + userLine);

    expect(await conversationExists()).toBe('present');
  });

  it('sees the conversation missing when the byte order mark opens a title-only stub', async () => {
    writeTranscript(BOM + titleOnlyStub);

    expect(await conversationExists()).toBe('missing');
  });

  it('sees the conversation present when a byte order mark opens a later line, not only the first', async () => {
    writeTranscript(titleOnlyStub + BOM + userLine);

    expect(await conversationExists()).toBe('present');
  });

  it('sees the conversation missing when a byte order mark sits inside a line', async () => {
    writeTranscript(titleOnlyStub + `{${BOM}"type":"user"}\n`);

    expect(await conversationExists()).toBe('missing');
  });

  it('sees the conversation missing for a UTF-16 transcript, which the CLI never writes', async () => {
    writeTranscript(Buffer.from(BOM + userLine, 'utf16le'));

    expect(await conversationExists()).toBe('missing');
  });

  it('sees the conversation present when lines end with CRLF', async () => {
    writeTranscript(titleOnlyStub.replace('\n', '\r\n') + userLine.replace('\n', '\r\n'));

    expect(await conversationExists()).toBe('present');
  });

  it('sees the conversation present when the user line is the last one and has no trailing newline', async () => {
    writeTranscript(titleOnlyStub + userLine.trimEnd());

    expect(await conversationExists()).toBe('present');
  });

  it('sees the conversation present when its user line straddles a 64 KB read boundary', async () => {
    writeTranscript(systemLineOfBytes(64 * 1024 - 20) + userLine);

    expect(await conversationExists()).toBe('present');
  });

  it('sees the conversation present when a multi-byte character straddles a 64 KB read boundary before the user line', async () => {
    const accentLine = `{"type":"system","note":"${'é'.repeat(40_000)}"}\n`;
    writeTranscript(accentLine + userLine);

    expect(await conversationExists()).toBe('present');
  });

  it('sees a title-only transcript of exactly 4 MB minus one byte as a stub, missing', async () => {
    writeTranscript(systemLineOfBytes(FOUR_MEGABYTES - 1));

    expect(await conversationExists()).toBe('missing');
  });

  it('sees a user-line-free transcript of exactly 4 MB as a conversation, present', async () => {
    writeTranscript(systemLineOfBytes(FOUR_MEGABYTES));

    expect(await conversationExists()).toBe('present');
  });

  it('sees a user line ending exactly at byte 4 MB found, present', async () => {
    writeTranscript(systemLineOfBytes(FOUR_MEGABYTES - userLine.length) + userLine);

    expect(await conversationExists()).toBe('present');
  });
});
