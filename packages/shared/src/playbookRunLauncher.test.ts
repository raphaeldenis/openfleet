import { describe, expect, it } from 'vitest';
import { PLAYBOOK_RUN_LAUNCHER_KINDS, PlaybookRunLauncherSchema } from './playbooks.js';

const accepts = (launcher: unknown) => PlaybookRunLauncherSchema.safeParse(launcher).success;

describe('who launched a playbook run', () => {
  it('names exactly four kinds', () => {
    expect([...PLAYBOOK_RUN_LAUNCHER_KINDS].sort()).toEqual(['admin_api', 'agent', 'trigger', 'unknown']);
  });

  it('accepts an agent that names its session', () => {
    expect(accepts({ kind: 'agent', ref: 'session-1' })).toBe(true);
  });

  it.each([null, '', undefined])('refuses an agent whose reference is %j', (ref) => {
    expect(accepts({ kind: 'agent', ref })).toBe(false);
  });

  it('accepts the admin API without a reference', () => {
    expect(accepts({ kind: 'admin_api', ref: null })).toBe(true);
  });

  it('refuses the admin API with a reference', () => {
    expect(accepts({ kind: 'admin_api', ref: 'trigger-1' })).toBe(false);
  });

  it('accepts a trigger that names itself', () => {
    expect(accepts({ kind: 'trigger', ref: 'trigger-1' })).toBe(true);
  });

  it.each([null, '', undefined])('refuses a trigger whose reference is %j', (ref) => {
    expect(accepts({ kind: 'trigger', ref })).toBe(false);
  });

  it('accepts an unknown launcher without a reference and refuses one with a reference', () => {
    expect(accepts({ kind: 'unknown', ref: null })).toBe(true);
    expect(accepts({ kind: 'unknown', ref: 'x' })).toBe(false);
  });

  it('refuses an unlisted kind and an unexpected field', () => {
    expect(accepts({ kind: 'cron', ref: null })).toBe(false);
    expect(accepts({ kind: 'admin_api', ref: null, extra: 1 })).toBe(false);
  });
});
