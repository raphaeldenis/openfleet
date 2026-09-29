import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it.each(['', 'not-a-uuid'])('never looks for a conversation named %j', async (cliSessionId) => {
    writeTranscript('-p', { fileName: `${cliSessionId}.jsonl` });

    expect(await conversationExists({ cliSessionId, directory: sessionDirectory })).toBe('missing');
  });
});
