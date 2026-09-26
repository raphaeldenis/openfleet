import { describe, expect, it } from 'vitest';
import { childEnvironment } from './childEnvironment.js';

describe('childEnvironment', () => {
  it('drops every Claude Code session marker but keeps the rest of the parent env', () => {
    const parentEnv = {
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
      CLAUDE_PID: '1',
      CLAUDE_EFFORT: 'high',
      PATH: '/usr/bin',
      HOME: '/home/user',
      ANTHROPIC_API_KEY: 'sk-test',
    };

    expect(childEnvironment(parentEnv)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
      ANTHROPIC_API_KEY: 'sk-test',
    });
  });
});
