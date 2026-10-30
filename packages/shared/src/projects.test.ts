import { describe, expect, it } from 'vitest';
import { CreateProjectRequestSchema, UpdateProjectRequestSchema } from './projects.js';

describe('CreateProjectRequestSchema', () => {
  it('trims the name and keeps an optional docs folder path', () => {
    const request = CreateProjectRequestSchema.parse({ name: '  Fleet  ', docsFolderPath: '/work/fleet-docs' });

    expect(request).toEqual({ name: 'Fleet', docsFolderPath: '/work/fleet-docs' });
  });

  it('accepts a name alone', () => {
    expect(CreateProjectRequestSchema.parse({ name: 'Fleet' })).toEqual({ name: 'Fleet' });
  });

  it.each(['', '   ', 'x'.repeat(81)])('rejects the name %j', (name) => {
    expect(() => CreateProjectRequestSchema.parse({ name })).toThrow();
  });

  it('accepts an 80-character name', () => {
    expect(CreateProjectRequestSchema.parse({ name: 'x'.repeat(80) }).name).toHaveLength(80);
  });

  it('rejects an empty docs folder path and unknown keys', () => {
    expect(() => CreateProjectRequestSchema.parse({ name: 'Fleet', docsFolderPath: '' })).toThrow();
    expect(() => CreateProjectRequestSchema.parse({ name: 'Fleet', id: 'forced-id' })).toThrow();
  });
});

describe('UpdateProjectRequestSchema escalation', () => {
  it('fills the defaults of the policy and counts as a change on its own', () => {
    const patch = UpdateProjectRequestSchema.parse({ escalation: { askUserGate: 'off' } });

    expect(patch.escalation).toMatchObject({ askUserGate: 'off', arbiterModel: 'opus', maxArbiterRunsPerTicket: 3 });
  });

  it('accepts null, which clears the setting', () => {
    expect(UpdateProjectRequestSchema.parse({ escalation: null })).toEqual({ escalation: null });
  });

  it('refuses a policy that removes contract from the human list', () => {
    expect(() => UpdateProjectRequestSchema.parse({ escalation: { humanClasses: ['security'] } })).toThrow();
  });
});

describe('CreateProjectRequestSchema profile', () => {
  const profile = { goal: 'Ship it', stack: ['TypeScript'], commands: { test: 'pnpm test' }, repositories: ['/work/fleet'] };

  it('accepts a profile next to the docs folder path', () => {
    const request = CreateProjectRequestSchema.parse({ name: 'Fleet', docsFolderPath: '/work/docs', profile });

    expect(request.profile).toEqual(profile);
  });

  it('refuses a profile without a docs folder path', () => {
    expect(() => CreateProjectRequestSchema.parse({ name: 'Fleet', profile })).toThrow();
  });

  it('refuses a 10 KB goal, unknown profile keys and unknown commands', () => {
    const withProfile = (changed: object) => CreateProjectRequestSchema.parse({ name: 'Fleet', docsFolderPath: '/work/docs', profile: { ...profile, ...changed } });

    expect(() => withProfile({ goal: 'x'.repeat(10_000) })).toThrow();
    expect(() => withProfile({ extra: 1 })).toThrow();
    expect(() => withProfile({ commands: { deploy: 'make deploy' } })).toThrow();
  });

  it('refuses too many stack bullets', () => {
    expect(() => CreateProjectRequestSchema.parse({ name: 'Fleet', docsFolderPath: '/work/docs', profile: { stack: Array.from({ length: 21 }, (_, i) => `s${i}`) } })).toThrow();
  });
});

describe('UpdateProjectRequestSchema', () => {
  it('accepts a name, a docs folder path or both', () => {
    expect(UpdateProjectRequestSchema.parse({ name: ' Renamed ' })).toEqual({ name: 'Renamed' });
    expect(UpdateProjectRequestSchema.parse({ docsFolderPath: '/work/docs' })).toEqual({ docsFolderPath: '/work/docs' });
    expect(UpdateProjectRequestSchema.parse({ name: 'N', docsFolderPath: '/work/docs' })).toEqual({ name: 'N', docsFolderPath: '/work/docs' });
  });

  it('refuses an empty patch, a blank name and unknown keys', () => {
    expect(() => UpdateProjectRequestSchema.parse({})).toThrow();
    expect(() => UpdateProjectRequestSchema.parse({ name: '  ' })).toThrow();
    expect(() => UpdateProjectRequestSchema.parse({ name: 'N', createdAt: 'x' })).toThrow();
  });
});
