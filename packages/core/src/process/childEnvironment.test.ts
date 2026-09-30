import { describe, expect, it } from 'vitest';
import { childEnvironmentForClaudeCli, childEnvironmentForGit } from './childEnvironment.js';

describe('childEnvironmentForGit', () => {
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

    expect(childEnvironmentForGit(parentEnv)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
      ANTHROPIC_API_KEY: 'sk-test',
    });
  });

  it('keeps CLAUDE_CONFIG_DIR, which selects the user config dir and is not a session marker', () => {
    const parentEnv = { CLAUDE_CONFIG_DIR: '/home/user/.claude' };

    expect(childEnvironmentForGit(parentEnv)).toEqual({ CLAUDE_CONFIG_DIR: '/home/user/.claude' });
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

    expect(childEnvironmentForGit(parentEnv)).toEqual(parentEnv);
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

    expect(childEnvironmentForGit(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps both ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL', () => {
    const parentEnv = { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'https://api.example.com' };

    expect(childEnvironmentForGit(parentEnv)).toEqual(parentEnv);
  });

  it('keeps near-miss names that are not an exact marker match: CLAUDE_CODE, CLAUDECODE_X, and lowercase claudecode', () => {
    const parentEnv = { CLAUDE_CODE: 'no-trailing-underscore', CLAUDECODE_X: 'not-the-literal-marker', claudecode: 'wrong-case' };

    expect(childEnvironmentForGit(parentEnv)).toEqual(parentEnv);
  });

  it('drops a key whose value is undefined, since node-pty would spawn it as the literal string "NAME=undefined"', () => {
    const parentEnv = { OPTIONAL_VAR: undefined, PATH: '/usr/bin' };

    const result = childEnvironmentForGit(parentEnv);

    expect(Object.prototype.hasOwnProperty.call(result, 'OPTIONAL_VAR')).toBe(false);
    expect(result.PATH).toBe('/usr/bin');
  });

  it('does not mutate the parent env object passed in', () => {
    const parentEnv = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', PATH: '/usr/bin' };
    const parentEnvSnapshot = { ...parentEnv };

    childEnvironmentForGit(parentEnv);

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

    expect(childEnvironmentForGit(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('never hands the sidecar stdin-EOF switch to a git child', () => {
    const parentEnv = { OPENFLEET_EXIT_ON_STDIN_EOF: '1', PATH: '/usr/bin' };

    expect(childEnvironmentForGit(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps a Scape-looking configuration variable, which is not host identity or capability', () => {
    const parentEnv = { SCAPE_THEME: 'dark' };

    expect(childEnvironmentForGit(parentEnv)).toEqual({ SCAPE_THEME: 'dark' });
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

    expect(childEnvironmentForGit(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps git configuration vars, which are not repository-location vars', () => {
    const parentEnv = { GIT_SSH_COMMAND: 'ssh -i key', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_EDITOR: 'vim' };

    expect(childEnvironmentForGit(parentEnv)).toEqual(parentEnv);
  });

  it('drops GIT_CONFIG_PARAMETERS, the inline config-injection var git itself uses to pass --config down to subprocesses', () => {
    const parentEnv = { GIT_CONFIG_PARAMETERS: "'core.hooksPath=/tmp/attacker-hooks'", PATH: '/usr/bin' };

    expect(childEnvironmentForGit(parentEnv)).toEqual({ PATH: '/usr/bin' });
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

    expect(childEnvironmentForGit(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM, which redirect where git reads its global/system config file from', () => {
    const parentEnv = {
      GIT_CONFIG_GLOBAL: '/tmp/attacker.gitconfig',
      GIT_CONFIG_SYSTEM: '/tmp/attacker-system.gitconfig',
      PATH: '/usr/bin',
    };

    expect(childEnvironmentForGit(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops the legacy GIT_CONFIG var, which redirects the file `git config` itself reads and writes', () => {
    const parentEnv = { GIT_CONFIG: '/tmp/attacker.config', PATH: '/usr/bin' };

    expect(childEnvironmentForGit(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops GIT_EXEC_PATH, which redirects where git resolves its own dashed subcommands and helpers from', () => {
    const parentEnv = { GIT_EXEC_PATH: '/tmp/attacker-exec-path', PATH: '/usr/bin' };

    expect(childEnvironmentForGit(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops GIT_TEMPLATE_DIR, which seeds hooks into any repo our own test helpers create with `git init`', () => {
    const parentEnv = { GIT_TEMPLATE_DIR: '/tmp/attacker-template', PATH: '/usr/bin' };

    expect(childEnvironmentForGit(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops every GIT_TRACE* destination var, since any of them can name a file git appends its own diagnostics to', () => {
    const parentEnv = {
      GIT_TRACE: '/tmp/attacker-trace.log',
      GIT_TRACE2: '/tmp/attacker-trace2.log',
      GIT_TRACE2_EVENT: '/tmp/attacker-trace2-event.log',
      GIT_TRACE2_PERF: '/tmp/attacker-trace2-perf.log',
      GIT_TRACE_PACKET: '/tmp/attacker-trace-packet.log',
      GIT_TRACE_PERFORMANCE: '/tmp/attacker-trace-performance.log',
      GIT_TRACE_SETUP: '/tmp/attacker-trace-setup.log',
      GIT_TRACE_SHALLOW: '/tmp/attacker-trace-shallow.log',
      GIT_TRACE_CURL: '/tmp/attacker-trace-curl.log',
      PATH: '/usr/bin',
    };

    expect(childEnvironmentForGit(parentEnv)).toEqual({ PATH: '/usr/bin' });
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

    expect(childEnvironmentForGit(parentEnv)).toEqual({
      scape_session_uuid: 'wrong-case',
      SCAPE_SESSION: 'missing-suffix',
      SCAPE_SESSION_UUIDX: 'extra-suffix',
      PATH: '/usr/bin',
    });
  });
});

describe('childEnvironmentForClaudeCli', () => {
  it('drops every Claude Code session marker and every Scape host-identity marker, keeping the rest of the parent env', () => {
    const parentEnv = {
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      SCAPE_SESSION_UUID: 'session-uuid',
      SCAPE_EMBEDDED: '1',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-test',
    };

    expect(childEnvironmentForClaudeCli(parentEnv)).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test' });
  });

  it('never hands the sidecar stdin-EOF switch to a launched claude, where a dev daemon would inherit it and exit at once', () => {
    const parentEnv = { OPENFLEET_EXIT_ON_STDIN_EOF: '1', PATH: '/usr/bin' };

    expect(childEnvironmentForClaudeCli(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('drops every git repository-location var, so a CLI launched in one worktree cannot be redirected to another repo', () => {
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
      GIT_EXEC_PATH: '/tmp/attacker-exec-path',
      GIT_TEMPLATE_DIR: '/tmp/attacker-template',
      PATH: '/usr/bin',
    };

    expect(childEnvironmentForClaudeCli(parentEnv)).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps GIT_CONFIG_GLOBAL/SYSTEM, legacy GIT_CONFIG, indexed GIT_CONFIG_KEY/VALUE, GIT_CONFIG_COUNT and GIT_CONFIG_PARAMETERS: the CLI\'s own git identity is the user\'s intent, not an attacker\'s', () => {
    const parentEnv = {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/etc/gitconfig-ci',
      GIT_CONFIG: '/home/user/.gitconfig',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'CI Bot',
      GIT_CONFIG_PARAMETERS: "'user.email=ci@example.com'",
      PATH: '/usr/bin',
    };

    expect(childEnvironmentForClaudeCli(parentEnv)).toEqual(parentEnv);
  });

  it('keeps every GIT_TRACE* destination var: the CLI is not the daemon\'s own git call', () => {
    const parentEnv = { GIT_TRACE: '/home/user/git-trace.log', GIT_TRACE2: '/home/user/git-trace2.log', PATH: '/usr/bin' };

    expect(childEnvironmentForClaudeCli(parentEnv)).toEqual(parentEnv);
  });

  it('drops a key whose value is undefined, since node-pty would spawn it as the literal string "NAME=undefined"', () => {
    const parentEnv = { OPTIONAL_VAR: undefined, PATH: '/usr/bin' };

    const result = childEnvironmentForClaudeCli(parentEnv);

    expect(Object.prototype.hasOwnProperty.call(result, 'OPTIONAL_VAR')).toBe(false);
    expect(result.PATH).toBe('/usr/bin');
  });
});
