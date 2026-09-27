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
      CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    };

    expect(childEnvironment(parentEnv)).toEqual(parentEnv);
  });

  it('drops every marker in the session/nesting Set, including ones not covered by the first test', () => {
    const parentEnv = {
      CLAUDE_JOB_DIR: '/tmp/job',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude',
      CLAUDE_CODE_SESSION_KIND: 'daemon',
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

  it('drops every Scape host-identity marker a launched daemon must not pass on to a nested claude', () => {
    const parentEnv = {
      SCAPE_SESSION_UUID: 'session-uuid',
      SCAPE_PARENT_ARGUS_ID: 'argus-id',
      SCAPE_EDIT_CAP: 'cap-token',
      SCAPE_EDIT_SOCK: '/tmp/scape-edit.sock',
      SCAPE_EDIT_PUBKEY: 'pubkey',
      SCAPE_EMBEDDED: '1',
      SCAPE_APP: 'scape',
      PATH: '/usr/bin',
    };

    expect(childEnvironment(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps a Scape-looking configuration variable, which is not host identity or capability', () => {
    const parentEnv = { SCAPE_THEME: 'dark' };

    expect(childEnvironment(parentEnv)).toEqual({ SCAPE_THEME: 'dark' });
  });

  it('drops every git repository-location var, so a git child cannot be redirected to another repo', () => {
    const parentEnv = {
      GIT_DIR: '/some/other/repo/.git',
      GIT_WORK_TREE: '/some/other/repo',
      GIT_INDEX_FILE: '/some/other/repo/.git/index',
      GIT_COMMON_DIR: '/some/other/repo/.git',
      GIT_OBJECT_DIRECTORY: '/some/other/repo/.git/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/some/other/repo/.git/objects',
      GIT_NAMESPACE: 'ns',
      GIT_CEILING_DIRECTORIES: '/some',
      GIT_PREFIX: 'sub/',
      PATH: '/usr/bin',
    };

    expect(childEnvironment(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps git configuration vars, which are not repository-location vars', () => {
    const parentEnv = { GIT_SSH_COMMAND: 'ssh -i key', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_EDITOR: 'vim' };

    expect(childEnvironment(parentEnv)).toEqual(parentEnv);
  });

  it('drops GIT_CONFIG_PARAMETERS, the inline config-injection var git itself uses to pass --config down to subprocesses', () => {
    const parentEnv = { GIT_CONFIG_PARAMETERS: "'core.hooksPath=/tmp/attacker-hooks'", PATH: '/usr/bin' };

    expect(childEnvironment(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops every indexed GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n pair and GIT_CONFIG_COUNT, the modern config-injection mechanism', () => {
    const parentEnv = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/tmp/attacker-hooks',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '!/tmp/steal-creds.sh',
      PATH: '/usr/bin',
    };

    expect(childEnvironment(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM, which redirect where git reads its global/system config file from', () => {
    const parentEnv = {
      GIT_CONFIG_GLOBAL: '/tmp/attacker.gitconfig',
      GIT_CONFIG_SYSTEM: '/tmp/attacker-system.gitconfig',
      PATH: '/usr/bin',
    };

    expect(childEnvironment(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops the legacy GIT_CONFIG var, which redirects the file `git config` itself reads and writes', () => {
    const parentEnv = { GIT_CONFIG: '/tmp/attacker.config', PATH: '/usr/bin' };

    expect(childEnvironment(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops GIT_EXEC_PATH, which redirects where git resolves its own dashed subcommands and helpers from', () => {
    const parentEnv = { GIT_EXEC_PATH: '/tmp/attacker-exec-path', PATH: '/usr/bin' };

    expect(childEnvironment(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops GIT_TEMPLATE_DIR, which seeds hooks into any repo our own test helpers create with `git init`', () => {
    const parentEnv = { GIT_TEMPLATE_DIR: '/tmp/attacker-template', PATH: '/usr/bin' };

    expect(childEnvironment(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops every marker from both the Claude Code and Scape families in one call, while keeping near-miss and case-variant names', () => {
    const parentEnv = {
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      SCAPE_SESSION_UUID: 'session-uuid',
      SCAPE_EMBEDDED: '1',
      scape_session_uuid: 'wrong-case',
      SCAPE_SESSION: 'missing-suffix',
      SCAPE_SESSION_UUIDX: 'extra-suffix',
      PATH: '/usr/bin',
    };

    expect(childEnvironment(parentEnv)).toEqual({
      scape_session_uuid: 'wrong-case',
      SCAPE_SESSION: 'missing-suffix',
      SCAPE_SESSION_UUIDX: 'extra-suffix',
      PATH: '/usr/bin',
    });
  });
});
