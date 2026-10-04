import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessLaunch } from '../harness.js';

type DataListener = (data: string) => void;
type ExitListener = (event: { exitCode: number; signal?: number }) => void;

const spawn = vi.fn(() => {
  const dataListeners: DataListener[] = [];
  const exitListeners: ExitListener[] = [];
  return {
    onData: (listener: DataListener) => { dataListeners.push(listener); return { dispose: () => undefined }; },
    onExit: (listener: ExitListener) => { exitListeners.push(listener); return { dispose: () => undefined }; },
    write: vi.fn(),
    resize: () => undefined,
    kill: () => undefined,
    printToTerminal: (text: string) => dataListeners.forEach((listener) => listener(text)),
    exitWith: (exitCode: number) => exitListeners.forEach((listener) => listener({ exitCode })),
  };
});

vi.mock('node-pty', () => ({ spawn }));
vi.mock('./trustDirectory.js', () => ({ markDirectoryTrusted: vi.fn() }));
vi.mock('../../process/executableOnPath.js', async (importOriginal) => ({ ...(await importOriginal<object>()), findExecutable: () => '/mocked/bin/claude' }));

const MISSING_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const REAL_STDERR = `No conversation found with session ID: ${MISSING_CONVERSATION_ID}`;

const resumeLaunch: HarnessLaunch = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  cliSessionId: MISSING_CONVERSATION_ID,
  resuming: true,
  directory: '/tmp/wt',
  hookUrl: 'http://127.0.0.1:7331/hooks/tok-hook',
  mcpUrl: 'http://127.0.0.1:7331/mcp',
  mcpToken: 'tok-mcp',
  displayName: '⚔️ Gimli - CCM-1',
};

async function launchAndRun({ launch, terminalOutput, exitCode }: { launch: HarnessLaunch; terminalOutput: string[]; exitCode: number }) {
  const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
  const handle = new ClaudeCliHarness(mkdtempSync(join(tmpdir(), 'of-conversation-not-found-'))).start(launch);
  const exits: Array<{ exitCode: number; wasConversationNotFound: boolean }> = [];
  handle.onExit((code, exit) => exits.push({ exitCode: code, wasConversationNotFound: exit.wasConversationNotFound }));
  const pty = spawn.mock.results[0]!.value as ReturnType<typeof spawn>;
  terminalOutput.forEach((text) => pty.printToTerminal(text));
  pty.exitWith(exitCode);
  return exits;
}

describe('ClaudeCliHarness exit of a resume whose conversation is gone', () => {
  beforeEach(() => spawn.mockClear());

  it('reports the conversation as not found when the CLI prints its stable phrase and exits', async () => {
    const exits = await launchAndRun({ launch: resumeLaunch, terminalOutput: [`${REAL_STDERR}\r\n`], exitCode: 1 });

    expect(exits).toEqual([{ exitCode: 1, wasConversationNotFound: true }]);
  });

  it('recognizes the phrase through colors and a message split across pty chunks', async () => {
    const exits = await launchAndRun({
      launch: resumeLaunch, terminalOutput: ['\u001b[31mNo conversation found ', `with session ID: ${MISSING_CONVERSATION_ID}\u001b[0m\r\n`], exitCode: 1,
    });

    expect(exits).toEqual([{ exitCode: 1, wasConversationNotFound: true }]);
  });

  it.each([
    { label: 'a near-miss without the session id wording', output: 'No conversation found' },
    { label: 'a near-miss with another subject', output: 'No session found with session ID: abc' },
    { label: 'an unrelated failure', output: 'Error: something else went wrong' },
    { label: 'no output at all', output: '' },
  ])('does not report not found for $label', async ({ output }) => {
    const exits = await launchAndRun({ launch: resumeLaunch, terminalOutput: [output], exitCode: 1 });

    expect(exits).toEqual([{ exitCode: 1, wasConversationNotFound: false }]);
  });

  it('never reports not found for a launch that is not a resume, even when the phrase is printed', async () => {
    const freshLaunch: HarnessLaunch = { ...resumeLaunch, resuming: false };

    const exits = await launchAndRun({ launch: freshLaunch, terminalOutput: [REAL_STDERR], exitCode: 1 });

    expect(exits).toEqual([{ exitCode: 1, wasConversationNotFound: false }]);
  });
});
