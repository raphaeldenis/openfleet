import { describe, expect, it } from 'vitest';
import { TEAM_VARIABLE_NAMES, TeamVariablesSchema, TemplateRenderError, referencedVariables, renderTemplate, renderTemplateSet } from './teamPack.js';
import type { TeamVariables } from './teamPack.js';

const completeVariables = (): TeamVariables => ({
  project: { name: 'Orchard', goal: 'Ship the orchard app', repoPath: '/work/orchard', docsFolder: '/docs/orchard', stack: 'TypeScript, Vue 3', defaultBranch: 'main' },
  commands: { install: 'pnpm install', build: 'pnpm build', test: 'pnpm test', dev: 'pnpm dev', verify: 'pnpm verify', lint: 'pnpm lint', typecheck: 'pnpm typecheck' },
  agent: { language: 'fr', role: 'dev', persona: 'Ada', emoji: '🛠' },
  parent: { name: 'Lead Orchard' },
  models: { scout: 'haiku', worker: 'sonnet', reviewer: 'sonnet', escalation: 'opus' },
  limits: { maxChildren: '5', pulseMinutes: '30' },
  paths: { evidenceDir: '/docs/orchard/reports', sandboxDir: '/sandbox/orchard' },
  stores: { backlog: 'store-1', log: 'store-2', findings: 'store-3' },
});

const placeholderOf = (variableName: string) => `{{${variableName}}}`;

const everyVariableTemplate = TEAM_VARIABLE_NAMES.map(placeholderOf).join('\n');

const errorCodeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof TemplateRenderError ? error.code : `unexpected: ${String(error)}`;
  }
  return undefined;
};

describe('renderTemplate: a variable resolves from the variables of the project', () => {
  it('replaces a placeholder with its value', () => {
    const rendered = renderTemplate('Project {{project.name}} runs {{commands.test}}.', completeVariables());

    expect(rendered).toBe('Project Orchard runs pnpm test.');
  });

  it('resolves every variable of the catalogue with the complete fixture', () => {
    const rendered = renderTemplate(everyVariableTemplate, completeVariables());

    expect(rendered).not.toContain('{{');
    expect(rendered.split('\n')).toHaveLength(TEAM_VARIABLE_NAMES.length);
  });

  it('lists the variables a template references, in order of appearance', () => {
    const names = referencedVariables('{{agent.role}} of {{project.name}} then {{agent.role}}');

    expect(names).toEqual(['agent.role', 'project.name', 'agent.role']);
  });

  it('renders an escaped opening as the literal text', () => {
    const rendered = renderTemplate('Write \\{{project.name}} to print the name of {{project.name}}.', completeVariables());

    expect(rendered).toBe('Write {{project.name}} to print the name of Orchard.');
  });

  it('leaves single braces and a lone closing pair as text', () => {
    const rendered = renderTemplate('{ json: 1 } }} end', completeVariables());

    expect(rendered).toBe('{ json: 1 } }} end');
  });
});

describe('renderTemplate: a variable that does not resolve fails at render time', () => {
  it('fails on a variable outside the catalogue', () => {
    expect(errorCodeOf(() => renderTemplate('Hello {{project.nickname}}', completeVariables()))).toBe('unknown_variable');
  });

  it('fails on a namespace outside the catalogue', () => {
    expect(errorCodeOf(() => renderTemplate('{{secret.token}}', completeVariables()))).toBe('unknown_variable');
  });

  it('fails when a value is missing from the variables', () => {
    const incomplete = { ...completeVariables(), parent: {} } as unknown as TeamVariables;

    expect(errorCodeOf(() => renderTemplate('{{parent.name}}', incomplete))).toBe('missing_value');
  });

  it('names the unknown variable in the error', () => {
    expect(() => renderTemplate('{{project.nickname}}', completeVariables())).toThrow(/project\.nickname/);
  });

  it('fails when referencedVariables meets a variable outside the catalogue', () => {
    expect(errorCodeOf(() => referencedVariables('{{nope.nada}}'))).toBe('unknown_variable');
  });
});

describe('renderTemplateSet: the whole pack renders against one fixture', () => {
  it('renders every template when the templates together use every variable', () => {
    const templates = { 'roles/dev.md': everyVariableTemplate, 'documents/house-rules.md': 'Rules of {{project.name}}' };

    const rendered = renderTemplateSet(templates, completeVariables());

    expect(rendered['documents/house-rules.md']).toBe('Rules of Orchard');
    expect(rendered['roles/dev.md']).toContain('pnpm verify');
  });

  it('fails when a variable of the fixture is used by no template', () => {
    const templates = { 'roles/dev.md': 'Rules of {{project.name}}' };

    expect(errorCodeOf(() => renderTemplateSet(templates, completeVariables()))).toBe('unused_variable');
  });

  it('names the unused variables in the error', () => {
    const templates = { 'roles/dev.md': TEAM_VARIABLE_NAMES.filter((name) => name !== 'stores.findings').map(placeholderOf).join(' ') };

    expect(() => renderTemplateSet(templates, completeVariables())).toThrow(/stores\.findings/);
  });

  it('fails on an unknown variable of any template, naming the template', () => {
    const templates = { 'roles/dev.md': everyVariableTemplate, 'roles/qe.md': '{{agent.mood}}' };

    expect(() => renderTemplateSet(templates, completeVariables())).toThrow(/roles\/qe\.md/);
  });
});

describe('the variables schema is the catalogue', () => {
  it('accepts the complete fixture', () => {
    expect(TeamVariablesSchema.safeParse(completeVariables()).success).toBe(true);
  });

  it('rejects a variable outside the catalogue', () => {
    const withExtra = { ...completeVariables(), project: { ...completeVariables().project, nickname: 'x' } };

    expect(TeamVariablesSchema.safeParse(withExtra).success).toBe(false);
  });

  it('rejects a missing variable', () => {
    const { parent: _parent, ...withoutParent } = completeVariables();

    expect(TeamVariablesSchema.safeParse(withoutParent).success).toBe(false);
  });

  it('lists twenty-nine variables', () => {
    expect(TEAM_VARIABLE_NAMES).toHaveLength(6 + 7 + 4 + 1 + 4 + 2 + 2 + 3);
  });
});
