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

  it('keeps CLAUDE_CONFIG_DIR, which selects the user config dir and is not a session marker', () => {
    const parentEnv = { CLAUDE_CONFIG_DIR: '/home/user/.claude' };

    expect(childEnvironment(parentEnv)).toEqual({ CLAUDE_CONFIG_DIR: '/home/user/.claude' });
  });

  it('keeps legitimate CLAUDE_CODE_ configuration variables, which are not session markers', () => {
    const parentEnv = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_CLIENT_CERT: '/path/cert.pem',
      CLAUDE_CODE_CLIENT_KEY: '/path/key.pem',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '3600000',
    };

    expect(childEnvironment(parentEnv)).toEqual(parentEnv);
  });

  it('drops every marker in the session/nesting Set, including ones not covered by the first test', () => {
    const parentEnv = {
      CLAUDE_JOB_DIR: '/tmp/job',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude',
      CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_SSE_PORT: '1234',
      PATH: '/usr/bin',
    };

    expect(childEnvironment(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps both ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL', () => {
    const parentEnv = { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'https://api.example.com' };

    expect(childEnvironment(parentEnv)).toEqual(parentEnv);
  });

  it('keeps near-miss names that are not an exact marker match: CLAUDE_CODE, CLAUDECODE_X, and lowercase claudecode', () => {
    const parentEnv = { CLAUDE_CODE: 'no-trailing-underscore', CLAUDECODE_X: 'not-the-literal-marker', claudecode: 'wrong-case' };

    expect(childEnvironment(parentEnv)).toEqual(parentEnv);
  });

  it('drops a key whose value is undefined, since node-pty would spawn it as the literal string "NAME=undefined"', () => {
    const parentEnv = { OPTIONAL_VAR: undefined, PATH: '/usr/bin' };

    const result = childEnvironment(parentEnv);

    expect(Object.prototype.hasOwnProperty.call(result, 'OPTIONAL_VAR')).toBe(false);
    expect(result.PATH).toBe('/usr/bin');
  });

  it('does not mutate the parent env object passed in', () => {
    const parentEnv = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', PATH: '/usr/bin' };
    const parentEnvSnapshot = { ...parentEnv };

    childEnvironment(parentEnv);

    expect(parentEnv).toEqual(parentEnvSnapshot);
  });
});
