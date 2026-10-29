import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_TEMPLATE_VALUE_CHARS, TemplateRenderError, renderTemplate } from './teamPack.js';
import type { TeamVariables } from './teamPack.js';

const variablesNamed = (projectName: string): TeamVariables => ({
  project: { name: projectName, goal: 'goal', repoPath: '/work/x', docsFolder: '/docs/x', stack: 'TypeScript', defaultBranch: 'main' },
  commands: { install: 'i', build: 'b', test: 't', dev: 'd', verify: 'v', lint: 'l', typecheck: 'c' },
  agent: { language: 'fr', role: 'dev', persona: 'Ada', emoji: 'x' },
  parent: { name: 'Lead' },
  models: { scout: 'haiku', worker: 'sonnet', reviewer: 'sonnet', escalation: 'opus' },
  limits: { maxChildren: '5', pulseMinutes: '30' },
  paths: { evidenceDir: '/e', sandboxDir: '/s' },
  stores: { backlog: '1', log: '2', findings: '3' },
});

const PROJECT_LINE = 'Project: {{project.name}}';
const renderedProjectLine = (projectName: string) => renderTemplate(PROJECT_LINE, variablesNamed(projectName));
const valueOf = (rendered: string) => rendered.slice('Project: '.length);

const outcomeOf = (action: () => string): { rendered: string } | { code: string } => {
  try {
    return { rendered: action() };
  } catch (error) {
    return error instanceof TemplateRenderError ? { code: error.code } : { code: `unexpected: ${String(error)}` };
  }
};

describe('a project name cannot break out of its line', () => {
  it('keeps a template placeholder inside the name as inert text', () => {
    const rendered = renderedProjectLine('{{agent.role}}');

    expect(rendered).not.toContain('{');
    expect(rendered).not.toContain('dev');
  });

  it('does not expand anything when the rendered output is rendered again', () => {
    const once = renderedProjectLine('x {{agent.role}} y {{ {agent.role}} }}');

    const twice = renderTemplate(once, variablesNamed('other'));

    expect(twice).toBe(once);
  });

  it('does not rebuild a placeholder from the value and the template text around it', () => {
    const adjacentPlaceholders = renderTemplate('{{project.name}}{agent.role}}', variablesNamed('{'));

    const secondPass = renderTemplate(adjacentPlaceholders, variablesNamed('other'));

    expect(secondPass).toBe(adjacentPlaceholders);
  });

  it('flattens a newline into one line', () => {
    expect(valueOf(renderedProjectLine('first\nsecond\r\nthird\ttab'))).toBe('first second third tab');
  });

  it('drops a NUL byte', () => {
    expect(valueOf(renderedProjectLine('ab\u0000cd'))).toBe('abcd');
  });

  it('caps a 10 KB name at 300 characters on one line', () => {
    const value = valueOf(renderedProjectLine('a'.repeat(10 * 1024)));

    expect(value).toHaveLength(MAX_TEMPLATE_VALUE_CHARS);
    expect(MAX_TEMPLATE_VALUE_CHARS).toBe(300);
    expect(value).not.toMatch(/[\r\n]/);
  });

  it('caps a 10 KB name made of newlines and text without leaving a line break', () => {
    const value = valueOf(renderedProjectLine('word\n'.repeat(2000)));

    expect(value.length).toBeLessThanOrEqual(300);
    expect(value).not.toMatch(/[\r\n]/);
  });

  it('does not cut a character made of two UTF-16 units in half', () => {
    const value = valueOf(renderedProjectLine('😀'.repeat(400)));

    expect(value.length).toBeLessThanOrEqual(300);
    expect(value).toBe([...value].join(''));
    expect(value).not.toMatch(/[\ud800-\udbff]$/);
  });

  it('removes invisible format characters, even those that would rejoin braces', () => {
    const invisible = ['​', '‮', '⁠', '﻿', String.fromCodePoint(0xe0041), String.fromCodePoint(0xe007f), String.fromCodePoint(0xe0000)];
    const name = `a${invisible.join('')}b{${invisible[0]}{agent.role}${invisible[1]}}c`;

    const value = valueOf(renderedProjectLine(name));

    expect(value).toBe('abagent.rolec');
  });

  it('turns the line and paragraph separators into spaces', () => {
    expect(valueOf(renderedProjectLine('a b c'))).toBe('a b c');
  });

  it.each([
    ['a carriage return', '\r'],
    ['a line separator', String.fromCodePoint(0x2028)],
    ['a paragraph separator', String.fromCodePoint(0x2029)],
    ['a vertical tab', '\v'],
    ['a form feed', '\f'],
  ])('turns %s into a space', (_name, lineBreak) => {
    expect(valueOf(renderedProjectLine(`a${lineBreak}b`))).toBe('a b');
  });

  it('leaves no line break of any kind in a value that mixes them', () => {
    const mixedBreaks = ['\r\n', String.fromCodePoint(0x2028), String.fromCodePoint(0x2029), '\r\r'].join('');

    const value = valueOf(renderedProjectLine(`a${mixedBreaks}b`));

    expect(value).toBe('a b');
  });

  it('collapses runs of spaces and trims the value', () => {
    expect(valueOf(renderedProjectLine('   many     spaces   '))).toBe('many spaces');
  });

  it('keeps a name made only of invisible characters as an empty value', () => {
    expect(renderedProjectLine('​‮\u0000')).toBe('Project: ');
  });

  it('produces the same output every time for the same input', () => {
    const hostile = '{{agent.role}}\n\u0000​' + 'z'.repeat(5000);

    expect(renderedProjectLine(hostile)).toBe(renderedProjectLine(hostile));
  });
});

describe('a hostile template fails cleanly and quickly', () => {
  const LARGE = 200_000;

  it('rejects an opening that is never closed', () => {
    expect(outcomeOf(() => renderTemplate('start {{project.name', variablesNamed('x')))).toEqual({ code: 'malformed_placeholder' });
  });

  it('rejects an empty placeholder', () => {
    expect(outcomeOf(() => renderTemplate('{{}}', variablesNamed('x')))).toEqual({ code: 'malformed_placeholder' });
  });

  it('rejects a placeholder with an expression, a filter or spaces', () => {
    const attempts = ['{{ project.name }}', '{{project.name | upper}}', '{{project.name + 1}}', '{{#if project.name}}', '{{project}}'];

    expect(attempts.map((attempt) => outcomeOf(() => renderTemplate(attempt, variablesNamed('x'))))).toEqual(attempts.map(() => ({ code: 'malformed_placeholder' })));
  });

  it('rejects a triple opening brace', () => {
    expect(outcomeOf(() => renderTemplate('{{{project.name}}}', variablesNamed('x')))).toEqual({ code: 'malformed_placeholder' });
  });

  it('rejects a deeply nested placeholder', () => {
    const nested = '{{'.repeat(LARGE) + 'project.name' + '}}'.repeat(LARGE);

    expect(outcomeOf(() => renderTemplate(nested, variablesNamed('x')))).toEqual({ code: 'malformed_placeholder' });
  });

  it('rejects an opening repeated without closing', () => {
    expect(outcomeOf(() => renderTemplate('{{'.repeat(LARGE), variablesNamed('x')))).toEqual({ code: 'malformed_placeholder' });
  });

  it('rejects a very long variable name without echoing it', () => {
    const longName = `{{${'a'.repeat(LARGE)}.b}}`;

    const outcome = outcomeOf(() => renderTemplate(longName, variablesNamed('x')));

    expect(outcome).toEqual({ code: 'malformed_placeholder' });
    expect(() => renderTemplate(longName, variablesNamed('x'))).toThrow(expect.objectContaining({ message: expect.stringMatching(/^.{0,200}$/s) }));
  });

  it('leaves many closing braces as text', () => {
    const closings = '}}'.repeat(LARGE);

    expect(renderTemplate(closings, variablesNamed('x'))).toBe(closings);
  });

  it('renders a template of many placeholders in linear time', () => {
    const template = '{{project.name}} '.repeat(LARGE);
    const startedAt = performance.now();

    const rendered = renderTemplate(template, variablesNamed('x'));

    expect(rendered).toHaveLength(2 * LARGE);
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it('sanitises a value of one million hostile characters in bounded time', () => {
    const hostileValue = '{{ \n​\u0000'.repeat(200_000);
    const startedAt = performance.now();

    const rendered = renderedProjectLine(hostileValue);

    expect(valueOf(rendered).length).toBeLessThanOrEqual(300);
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it('rejects hostile templates in bounded time', () => {
    const hostileTemplates = ['{{'.repeat(LARGE), '{{'.repeat(LARGE) + '}}'.repeat(LARGE), `{{${'a'.repeat(LARGE)}`, '{{ '.repeat(LARGE) + '}}', '\\{{'.repeat(LARGE) + '{{'];
    const startedAt = performance.now();

    hostileTemplates.forEach((template) => outcomeOf(() => renderTemplate(template, variablesNamed('x'))));

    expect(performance.now() - startedAt).toBeLessThan(2000);
  });
});

describe('renderTemplate stays pure', () => {
  const SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'teamPack.ts');
  const IMPURE_REFERENCES = [/node:/, /\bprocess\b/, /\bDate\b/, /Math\.random/, /\bfetch\b/, /performance\.now/, /\brequire\(/, /crypto/];

  it('reads no disk, network, clock or randomness', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');

    const impureReferences = IMPURE_REFERENCES.filter((reference) => reference.test(source)).map(String);

    expect(impureReferences).toEqual([]);
  });

  it('imports nothing from core or desktop', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');

    expect(source).not.toMatch(/from '[^']*(core|desktop)[^']*'/);
  });
});
