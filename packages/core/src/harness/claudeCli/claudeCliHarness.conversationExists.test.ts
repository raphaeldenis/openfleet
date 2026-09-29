import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

const conversationId = '33333333-3333-4333-8333-333333333333';
const projectDirectoryNameOf = (directory: string) => realpathSync(directory).replace(/[^a-zA-Z0-9]/g, '-');

describe('a user whose CLI conversation transcript may be gone', () => {
  let configDir: string;
  let sessionDirectory: string;
  let previousConfigDir: string | undefined;

  const conversationExists = async (input: { cliSessionId: string; directory: string }) => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    return new ClaudeCliHarness(join(configDir, 'sessions')).conversationExists(input);
  };

  const writeTranscript = (projectDirectoryName: string, fileName = `${conversationId}.jsonl`) => {
    const projectDirectory = join(configDir, 'projects', projectDirectoryName);
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(join(projectDirectory, fileName), '{"type":"custom-title"}\n');
  };

  beforeEach(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'of-claude-config-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    sessionDirectory = join(mkdtempSync(join(tmpdir(), 'of-cwd-')), 'my projet évolué');
    mkdirSync(sessionDirectory, { recursive: true });
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  });

  it('sees the conversation found in the project directory of its session, spaces and accents included', async () => {
    writeTranscript(projectDirectoryNameOf(sessionDirectory));

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe(true);
  });

  it('sees the conversation found under another project directory name when the CLI names it differently', async () => {
    writeTranscript('-named-by-a-newer-cli');

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe(true);
  });

  it('sees the conversation found when the session directory no longer exists', async () => {
    writeTranscript('-somewhere');

    expect(await conversationExists({ cliSessionId: conversationId, directory: join(sessionDirectory, 'gone') })).toBe(true);
  });

  it('sees the conversation missing when no project holds its transcript', async () => {
    writeTranscript(projectDirectoryNameOf(sessionDirectory), '44444444-4444-4444-8444-444444444444.jsonl');

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe(false);
  });

  it('sees the conversation missing when the projects directory does not exist', async () => {
    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe(false);
  });

  it('sees the conversation missing when its transcript name is a directory', async () => {
    mkdirSync(join(configDir, 'projects', '-p', `${conversationId}.jsonl`), { recursive: true });

    expect(await conversationExists({ cliSessionId: conversationId, directory: sessionDirectory })).toBe(false);
  });

  it('never follows a conversation id out of the projects directory', async () => {
    mkdirSync(join(configDir, 'projects', '-p'), { recursive: true });
    writeFileSync(join(configDir, 'outside.jsonl'), '{}\n');

    expect(await conversationExists({ cliSessionId: '../../outside', directory: sessionDirectory })).toBe(false);
  });

  it.each(['', 'not-a-uuid'])('never looks for a conversation named %j', async (cliSessionId) => {
    writeTranscript('-p', `${cliSessionId}.jsonl`);

    expect(await conversationExists({ cliSessionId, directory: sessionDirectory })).toBe(false);
  });
});
