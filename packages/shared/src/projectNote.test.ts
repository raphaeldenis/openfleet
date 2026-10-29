import { describe, expect, it } from 'vitest';
import { CreateProjectRequestSchema } from './projects.js';
import { MAX_PROJECT_NOTE_LINE_CHARS, projectNoteTitle, renderProjectNote } from './projectNote.js';

/** Builds a credential-shaped value at run time, so no scanner-recognised literal sits in the source. */
const fakeCredential = (prefix: string, body: string) => [prefix, body].join('');

const SK_KEY = fakeCredential('sk', '-ABCDEFGHIJKLMNOPQRSTUV');
const GHP_TOKEN = fakeCredential('ghp', '_abcdefghijklmnopqrstuvwxyz0123456789');
const GHO_TOKEN = fakeCredential('gho', '_abcdefghijklmnopqrstuvwxyz0123456789');
const AWS_ACCESS_KEY_ID = fakeCredential('AKIA', 'IOSFODNN7EXAMPLE');
const GITHUB_PAT = fakeCredential('github', `_pat_${'A1b2C3d4E5'.repeat(6)}`);
const GITLAB_TOKEN = fakeCredential('glpat', '-abcDEF123456ghiJKL78');
const SLACK_TOKEN = fakeCredential('xox', 'b-1234567890-abcdefghij');
const JWT = [fakeCredential('ey', 'JhbGciOiJIUzI1NiJ9'), fakeCredential('ey', 'JzdWIiOiIxMjM0NTYifQ'), 'c2lnbmF0dXJl'].join('.');
const NPM_TOKEN = fakeCredential('npm', `_${'a1B2c3D4e5'.repeat(3)}a1B2c3`);
const URL_WITH_PASSWORD = ['psql postgres:/', '/u:pw@h/db'].join('');

const FULL_PROFILE = {
  name: 'Fleet',
  goal: 'Ship the daemon',
  repositories: ['/work/fleet'],
  stack: ['TypeScript', 'Vue 3'],
  commands: { install: 'pnpm install', build: 'pnpm build', test: 'pnpm test', dev: 'pnpm dev' },
};

describe('projectNoteTitle', () => {
  it('prefixes the project name', () => {
    expect(projectNoteTitle('Fleet')).toBe('Project: Fleet');
  });
});

describe('CreateProjectRequestSchema name', () => {
  it('refuses a name that is nothing but template braces', () => {
    expect(CreateProjectRequestSchema.safeParse({ name: '{{}}' }).success).toBe(false);
  });

  it('accepts a name with text beside template braces', () => {
    expect(CreateProjectRequestSchema.safeParse({ name: 'Fleet {{x}}' }).success).toBe(true);
  });
});

describe('renderProjectNote', () => {
  it('writes the goal, repositories, stack bullets and commands under their own headings', () => {
    const body = renderProjectNote(FULL_PROFILE);

    expect(body).toBe([
      '# Project: Fleet',
      '',
      '## Goal',
      'Ship the daemon',
      '',
      '## Repositories',
      '- /work/fleet',
      '',
      '## Stack',
      '- TypeScript',
      '- Vue 3',
      '',
      '## Commands',
      '- install: `pnpm install`',
      '- build: `pnpm build`',
      '- test: `pnpm test`',
      '- dev: `pnpm dev`',
      '',
    ].join('\n'));
  });

  it('leaves out the sections that have nothing to say', () => {
    const body = renderProjectNote({ name: 'Fleet', goal: '', repositories: [], stack: [], commands: { test: 'pnpm test' } });

    expect(body).toBe(['# Project: Fleet', '', '## Commands', '- test: `pnpm test`', ''].join('\n'));
  });

  it('keeps a hostile name on one line, capped, without template braces', () => {
    const hostileName = `Fleet\n## Injected {{secret}} ${'x'.repeat(10_000)}`;

    const body = renderProjectNote({ ...FULL_PROFILE, name: hostileName });

    const [titleLine] = body.split('\n');
    expect(titleLine).not.toContain('{{');
    expect(titleLine).not.toContain('}}');
    expect(titleLine!.length).toBeLessThanOrEqual('# '.length + 'Project: '.length + MAX_PROJECT_NOTE_LINE_CHARS);
    expect(body.split('\n').filter((line) => line.startsWith('## Injected'))).toEqual([]);
  });

  it('keeps multi-line free text from opening a heading of its own', () => {
    const body = renderProjectNote({ ...FULL_PROFILE, goal: 'First line\n## Commands\n- install: `rm -rf /`' });

    expect(body.split('\n').filter((line) => line === '## Commands')).toHaveLength(1);
  });

  it('removes template braces from stack bullets and commands', () => {
    const body = renderProjectNote({ ...FULL_PROFILE, stack: ['{{project.stack}}'], commands: { test: 'echo {{x}}' } });

    expect(body).not.toContain('{{');
    expect(body).not.toContain('}}');
  });

  it('masks secret-looking assignments in commands and free text', () => {
    const body = renderProjectNote({ ...FULL_PROFILE, goal: 'use API_KEY=abc123 here', commands: { test: 'TOKEN=s3cr3t pnpm test' } });

    expect(body).not.toContain('abc123');
    expect(body).not.toContain('s3cr3t');
    expect(body).toContain('[redacted]');
  });

  it.each([
    ['a bearer header', 'Authorization: Bearer abc.def.ghi', ['abc.def.ghi']],
    ['an sk- key', `key ${SK_KEY} here`, [SK_KEY]],
    ['a ghp_ token', GHP_TOKEN, [GHP_TOKEN]],
    ['a gho_ token', GHO_TOKEN, [GHO_TOKEN]],
    ['an AWS access key id', AWS_ACCESS_KEY_ID, [AWS_ACCESS_KEY_ID]],
    ['a curl header', 'curl -H "Authorization: Bearer abcdef" x', ['abcdef']],
    ['a url password', URL_WITH_PASSWORD, [':pw@']],
    ['a quoted json password with a space', '{"password": "abc def"}', ['abc', 'def']],
    ['a single-quoted value with a space', "password = 'abc def'", ['abc', 'def']],
    ['a spoken password', 'password is hunter2', ['hunter2']],
    ['a multi-word value after a spaced equals', 'secret = alpha beta', ['alpha', 'beta']],
  ])('masks %s', (_label, text, leaked) => {
    const body = renderProjectNote({ ...FULL_PROFILE, goal: text });

    for (const fragment of leaked) expect(body).not.toContain(fragment);
    expect(body).toContain('[redacted]');
  });

  it.each(['password: hunter2', 'TOKEN=s3cr3t', 'API_KEY=abc123'])('still masks %s', (text) => {
    const body = renderProjectNote({ ...FULL_PROFILE, goal: text });

    expect(body).toContain('[redacted]');
    expect(body).not.toMatch(/hunter2|s3cr3t|abc123/);
  });

  it('keeps ordinary prose that mentions a password policy', () => {
    const body = renderProjectNote({ ...FULL_PROFILE, goal: 'Reset flow for the password form' });

    expect(body).toContain('Reset flow for the password form');
  });

  it('is the same text for the same inputs', () => {
    expect(renderProjectNote(FULL_PROFILE)).toBe(renderProjectNote({ ...FULL_PROFILE }));
  });

  it.each([
    ['github_pat_', GITHUB_PAT],
    ['glpat-', GITLAB_TOKEN],
    ['xox', SLACK_TOKEN],
    ['a JWT (eyJ)', JWT],
    ['npm_', NPM_TOKEN],
  ])('masks a %s credential written in prose', (_label, credential) => {
    const body = renderProjectNote({ ...FULL_PROFILE, goal: `Publish with ${credential} then tag` });

    expect(body).not.toContain(credential);
    expect(body).toContain('Publish with [redacted] then tag');
  });

  it.each([
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
    ['Authorization: token abcdef0123456789', 'abcdef0123456789'],
  ])('masks the credential after %s', (text, credential) => {
    const body = renderProjectNote({ ...FULL_PROFILE, goal: text });

    expect(body).not.toContain(credential);
    expect(body).toContain('Authorization: [redacted]');
  });
});
