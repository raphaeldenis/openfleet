import type { PolicyRequest } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { recentLogLines } from '../logger.js';
import { CommandPolicyFileUnreadableError } from './commandPolicyErrors.js';
import { CommandPolicyService, type PolicyFile } from './commandPolicyService.js';
import { defaultCommandPolicySettings } from './commandPolicySettings.js';
import { evaluateCommandPolicy } from './policyEvaluator.js';

class MemoryPolicyFile implements PolicyFile {
  writes: string[] = [];
  failsToWrite = false;
  constructor(public contents?: string) {}
  read() { return this.contents; }
  write(contents: string) {
    if (this.failsToWrite) throw new Error('disk gone');
    this.writes.push(contents);
    this.contents = contents;
  }
}

const serviceOver = (file: PolicyFile) => new CommandPolicyService({ base: defaultCommandPolicySettings(), file, evaluate: evaluateCommandPolicy });
const denyWithoutAlternative = { id: 'no-pnpm-install', tools: ['Bash'], decision: 'deny', when: { program: 'pnpm', subcommand: 'install' }, reason: 'Installs change the lockfile.' };
const denyWithAlternative = { ...denyWithoutAlternative, alternative: 'Ask your manager to run the install.' };

describe('the command policy service at boot', () => {
  it('enforces the delivered document when no file exists', () => {
    const service = serviceOver(new MemoryPolicyFile());

    expect(service.settings()).toEqual(defaultCommandPolicySettings());
    expect(service.view()).toMatchObject({ mode: 'observe', unattended: { askBecomesDeny: true }, override: null, issues: [] });
  });

  it('applies the mode, the disabled rules and the added rules of the file', () => {
    const file = new MemoryPolicyFile(JSON.stringify({ version: 1, mode: 'enforce', unattended: { askBecomesDeny: false }, disabledRules: ['no-forced-git-clean'], rules: [denyWithAlternative] }));

    const view = serviceOver(file).view();

    expect(view.mode).toBe('enforce');
    expect(view.unattended.askBecomesDeny).toBe(false);
    expect(view.rules.find((rule) => rule.id === 'no-forced-git-clean')).toMatchObject({ enabled: false, origin: 'delivered' });
    expect(view.rules.find((rule) => rule.id === 'no-forced-recursive-rm')).toMatchObject({ enabled: true, origin: 'delivered', decision: 'deny', profiles: expect.arrayContaining(['default', 'dev']) });
    expect(view.rules.find((rule) => rule.id === 'no-pnpm-install')).toMatchObject({ enabled: true, origin: 'custom', alternative: 'Ask your manager to run the install.' });
  });

  it('falls back to the delivered document when the file is not JSON, and says why', () => {
    const service = serviceOver(new MemoryPolicyFile('{not json'));

    expect(service.settings()).toEqual(defaultCommandPolicySettings());
    expect(service.view().issues).toHaveLength(1);
  });

  it('ignores a rule of the file that the schema refuses and keeps the rest', () => {
    const file = new MemoryPolicyFile(JSON.stringify({ version: 1, mode: 'enforce', rules: [denyWithoutAlternative] }));

    const view = serviceOver(file).view();

    expect(view.mode).toBe('enforce');
    expect(view.rules.some((rule) => rule.id === 'no-pnpm-install')).toBe(false);
    expect(view.issues.join(' ')).toContain('no-pnpm-install');
  });
});

describe('replacing the override', () => {
  it('refuses a deny without an alternative and touches neither the file nor the settings', () => {
    const file = new MemoryPolicyFile();
    const service = serviceOver(file);
    const before = service.settings();

    expect(() => service.replace({ version: 1, mode: 'enforce', rules: [denyWithoutAlternative] })).toThrow(expect.objectContaining({ name: 'ZodError' }));

    expect(file.writes).toEqual([]);
    expect(service.settings()).toBe(before);
  });

  it('refuses a role mapped to a profile that does not exist', () => {
    const service = serviceOver(new MemoryPolicyFile());

    expect(() => service.replace({ version: 1, roleToProfile: { DEV: 'ghost' } })).toThrow(expect.objectContaining({ code: 'invalid_body' }));
  });

  it('writes the override, then enforces it at once without a restart', () => {
    const file = new MemoryPolicyFile();
    const service = serviceOver(file);

    const view = service.replace({ version: 1, mode: 'enforce' });

    expect(JSON.parse(file.writes[0]!)).toEqual({ version: 1, mode: 'enforce' });
    expect(service.settings().document.mode).toBe('enforce');
    expect(view).toMatchObject({ mode: 'enforce', override: { version: 1, mode: 'enforce' } });
  });

  it('keeps enforcing the previous state when the file cannot be written', () => {
    const file = new MemoryPolicyFile();
    const service = serviceOver(file);
    file.failsToWrite = true;

    expect(() => service.replace({ version: 1, mode: 'enforce' })).toThrow('disk gone');

    expect(service.settings().document.mode).toBe('observe');
  });

  it('leaves a hand-edited file it cannot read untouched', () => {
    const file = new MemoryPolicyFile('{oops');
    const service = serviceOver(file);

    expect(() => service.replace({ version: 1, mode: 'enforce' })).toThrow(CommandPolicyFileUnreadableError);

    expect(file.contents).toBe('{oops');
  });

  it('writes a line in the log so the change can be traced', () => {
    const service = serviceOver(new MemoryPolicyFile());

    service.replace({ version: 1, mode: 'off', unattended: { askBecomesDeny: false } });

    expect(recentLogLines().some((line) => line.includes('command policy saved') && line.includes('"mode":"off"') && line.includes('"askBecomesDeny":false'))).toBe(true);
  });
});

describe('trying a command', () => {
  const rmRf: PolicyRequest = { sessionId: 'try', harness: 'claude-cli', role: 'DEV', presence: 'unattended', actor: 'session', source: 'pre_tool_use', toolName: 'Bash', command: 'rm -rf build', cwd: '/', scratchRoots: [] };

  it('answers with the verdict of the current document, the mode and the profile, and writes nothing', () => {
    const file = new MemoryPolicyFile();
    const service = serviceOver(file);
    service.replace({ version: 1, mode: 'enforce' });
    const writesBefore = file.writes.length;

    const result = service.evaluate(rmRf);

    expect(result).toMatchObject({ mode: 'enforce', profile: 'dev', verdict: { decision: 'deny', ruleId: 'no-forced-recursive-rm' } });
    expect(file.writes).toHaveLength(writesBefore);
  });
});
