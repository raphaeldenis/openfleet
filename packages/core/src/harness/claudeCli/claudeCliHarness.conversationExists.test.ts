import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

const conversationId = '33333333-3333-4333-8333-333333333333';
const projectDirectoryNameOf = (directory: string) => realpathSync(directory).replace(/[^a-zA-Z0-9]/g, '-');

const titleOnlyStub = '{"type":"custom-title","customTitle":"x","sessionId":"s"}\n';
const userLine = '{"type":"user","message":{"role":"user","content":"hello"}}\n';
const assistantLine = '{"type":"assistant","message":{"role":"assistant","content":"hi"}}\n';

describe('a user whose CLI conversation transcript may be gone', () => {
  let configDir: string;
  let sessionDirectory: string;
  let previousConfigDir: string | undefined;

  const conversationExists = async (input: { cliSessionId: string; directory: string }) => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    return new ClaudeCliHarness(join(configDir, 'sessions')).conversationExists(input);
  };

  const writeTranscript = (projectDirectoryName: string, { fileName = `${conversationId}.jsonl`, content = userLine } = {}) => {
    const projectDirectory = join(configDir, 'projects', projectDirectoryName);
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(join(projectDirectory, fileName), content);
  };

  beforeEach(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'of-claude-config-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    sessionDirectory = join(mkdtempSync(join(tmpdir(), 'of-cwd-')), 'my projet évolué');
    mkdirSync(sessionDirectory, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  });

  it('sees the conversation found in the project directory of its session, spaces and accents included', async () => {
    writeTranscript(projectDirectoryNameOf(sessionDirectory));

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
  });

  it('sees the conversation found under another project directory name when the CLI names it differently', async () => {
    writeTranscript('-named-by-a-newer-cli');

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
  });

  it('sees the conversation found when the session directory no longer exists', async () => {
    writeTranscript('-somewhere');

    expect(await conversationExists({ cliSessionId: conversationId, directory: join(sessionDirectory, 'gone') })).toBe('present');
  });

  it('sees the conversation present once its transcript holds an assistant line', async () => {
    writeTranscript('-p', { content: titleOnlyStub + assistantLine });

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
  });

  it('sees the conversation present when its first user line comes after a long run of other lines', async () => {
    const preamble = `{"type":"system","note":"${'x'.repeat(200_000)}"}\n`;
    writeTranscript('-p', { content: preamble + titleOnlyStub + userLine });

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
  });

  it('sees the conversation missing when the transcript is the title-only stub the CLI writes before it flushes', async () => {
    writeTranscript(projectDirectoryNameOf(sessionDirectory), { content: titleOnlyStub });

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('missing');
  });

  it('sees the conversation missing when its transcript holds only lines that are not JSON', async () => {
    writeTranscript('-p', { content: 'not json\n{"type":"user"\n\n42\n"user"\n' });

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('missing');
  });

  it('sees the conversation missing when its transcript is empty', async () => {
    writeTranscript('-p', { content: '' });

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('missing');
  });

  it('sees the conversation present when another project directory holds the real one behind a stub', async () => {
    writeTranscript(projectDirectoryNameOf(sessionDirectory), { content: titleOnlyStub });
    writeTranscript('-another', { content: userLine });

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
  });

  it('sees the conversation missing when no project holds its transcript', async () => {
    writeTranscript(projectDirectoryNameOf(sessionDirectory), { fileName: '44444444-4444-4444-8444-444444444444.jsonl' });

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('missing');
  });

  it('sees the conversation missing when the projects directory does not exist', async () => {
    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('missing');
  });

  it('sees the conversation missing when its transcript name is a directory', async () => {
    mkdirSync(join(configDir, 'projects', '-p', `${conversationId}.jsonl`), { recursive: true });

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('missing');
  });

  it('cannot tell when its transcript cannot be read for a reason other than being absent', async () => {
    const projectDirectory = join(configDir, 'projects', '-p');
    mkdirSync(projectDirectory, { recursive: true });
    symlinkSync(join(projectDirectory, `${conversationId}.jsonl`), join(projectDirectory, `${conversationId}.jsonl`));

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('unknown');
  });

  it('sees the unreadable transcript logged with the conversation id and the error code only, no path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const projectDirectory = join(configDir, 'projects', '-p');
    mkdirSync(projectDirectory, { recursive: true });
    symlinkSync(join(projectDirectory, `${conversationId}.jsonl`), join(projectDirectory, `${conversationId}.jsonl`));

    await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory });

    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(conversationId);
    expect(lines[0]).toContain('ELOOP');
    expect(lines[0]).not.toContain(configDir);
  });

  it('never follows a conversation id out of the projects directory', async () => {
    mkdirSync(join(configDir, 'projects', '-p'), { recursive: true });
    writeFileSync(join(configDir, 'outside.jsonl'), userLine);

    expect(await conversationExists({ cliSessionId: '../../outside', directory: sessionDirectory })).toBe('missing');
  });

  describe('when its user line sits at the edge of what is read at once', () => {
    const READ_CHUNK_BYTES = 64 * 1024;
    const systemLineOfBytes = (bytes: number) => {
      const emptyLine = '{"type":"system","note":""}\n';
      return `{"type":"system","note":"${'x'.repeat(bytes - emptyLine.length)}"}\n`;
    };
    const emojiUserLine = `{"type":"user","message":{"content":"${'🚀é'.repeat(40)}"}}\n`;

    it('sees the conversation present when the user line straddles the first chunk boundary', async () => {
      writeTranscript('-p', { content: systemLineOfBytes(READ_CHUNK_BYTES - 30) + userLine });

      expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
    });

    it('sees the conversation present when the user line starts exactly on the chunk boundary', async () => {
      writeTranscript('-p', { content: systemLineOfBytes(READ_CHUNK_BYTES) + userLine });

      expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
    });

    it.each([1, 2, 3, 5, 9, 40])('sees the conversation present when the boundary cuts the emoji of its user line %i bytes in', async (offset) => {
      writeTranscript('-p', { content: systemLineOfBytes(READ_CHUNK_BYTES - offset) + emojiUserLine });

      expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
    });

    it('sees the conversation present when its last user line has no trailing newline', async () => {
      writeTranscript('-p', { content: titleOnlyStub + userLine.trimEnd() });

      expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
    });
  });

  describe('when its transcript holds no user line and grows large', () => {
    const MAX_BYTES_SCANNED = 4 * 1024 * 1024;
    const systemLineOfBytes = (bytes: number) => `{"type":"system","note":"${'x'.repeat(bytes - 28)}"}\n`;

    it('sees the conversation present once it is as long as what the daemon agrees to read, a title-only stub never is that long', async () => {
      writeTranscript('-p', { content: systemLineOfBytes(MAX_BYTES_SCANNED) });

      expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
    });

    it('sees the conversation present when its user line only comes after more than what the daemon agrees to read', async () => {
      writeTranscript('-p', { content: systemLineOfBytes(MAX_BYTES_SCANNED + 1024 * 1024) + userLine });

      expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
    });

    it('sees the conversation missing when it stays one byte under what the daemon agrees to read', async () => {
      writeTranscript('-p', { content: systemLineOfBytes(MAX_BYTES_SCANNED - 1) });

      expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('missing');
    });
  });

  it('sees the conversation missing when its transcript holds a title line and a system line only', async () => {
    writeTranscript('-p', { content: `${titleOnlyStub}{"type":"system","note":"started"}\n` });

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('missing');
  });

  it('sees the conversation missing when a regular file stands where its project directory should be', async () => {
    mkdirSync(join(configDir, 'projects'), { recursive: true });
    writeFileSync(join(configDir, 'projects', projectDirectoryNameOf(sessionDirectory)), 'not a directory');

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('missing');
  });

  it('sees the conversation found in another project when its own project cannot be read', async () => {
    writeTranscript(projectDirectoryNameOf(sessionDirectory));
    chmodSync(join(configDir, 'projects', projectDirectoryNameOf(sessionDirectory), `${conversationId}.jsonl`), 0o000);
    writeTranscript('-another');

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('present');
  });

  it('sees the conversation present under the lower-case file name whatever the case of the stored id', async () => {
    const lowerCaseId = 'abcdef01-2345-4678-89ab-cdef01234567';
    writeTranscript('-p', { fileName: `${lowerCaseId}.jsonl` });

    expect(await conversationExists({ cliSessionId: lowerCaseId.toUpperCase(), directory: sessionDirectory })).toBe('present');
  });

  it.each([`x${conversationId}`, `../${conversationId}`])('never looks for a conversation whose id only ends with a real one: %j', async (cliSessionId) => {
    mkdirSync(join(configDir, 'projects', '-p'), { recursive: true });
    writeFileSync(join(configDir, 'projects', `${cliSessionId.replace('../', '')}.jsonl`), userLine);
    writeFileSync(join(configDir, 'projects', '-p', `${cliSessionId.replace('../', '')}.jsonl`), userLine);

    expect(await conversationExists({ cliSessionId, directory: sessionDirectory })).toBe('missing');
  });

  describe.skipIf(process.getuid?.() === 0)('when the permissions of the CLI config forbid reading', () => {
    it('cannot tell when the transcript itself is not readable', async () => {
      writeTranscript('-p');
      chmodSync(join(configDir, 'projects', '-p', `${conversationId}.jsonl`), 0o000);

      expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('unknown');
    });

    it('cannot tell when the projects directory is not readable', async () => {
      writeTranscript('-p');
      chmodSync(join(configDir, 'projects'), 0o000);
      try {
        expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe('unknown');
      } finally {
        chmodSync(join(configDir, 'projects'), 0o700);
      }
    });
  });

  it.each(['', 'not-a-uuid'])('never looks for a conversation named %j', async (cliSessionId) => {
    writeTranscript('-p', { fileName: `${cliSessionId}.jsonl` });

    expect(await conversationExists({ cliSessionId, directory: sessionDirectory })).toBe('missing');
  });
});
