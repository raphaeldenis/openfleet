import { describe, expect, it } from 'vitest';
import {
  MAX_PLAYBOOK_CELLS, MAX_SCRIPT_ARGUMENTS, PLAYBOOK_CELL_KINDS, PlaybookCellSchema, PlaybookFlowSchema, PlaybookInputsSchema, PlaybookPolicySchema,
} from './playbooks.js';

const scriptCell = (overrides: Record<string, unknown> = {}) => ({ id: 'build', kind: 'script', program: 'scripts/verify.sh', ...overrides });
const manyOf = (count: number, make: (position: number) => unknown) => Array.from({ length: count }, (_, position) => make(position));

describe('the cell kinds of the first wave', () => {
  it('lists the eight kinds and none that runs a shell string', () => {
    expect([...PLAYBOOK_CELL_KINDS].sort()).toEqual(['http', 'manual', 'readFromStore', 'script', 'subPlaybook', 'tool', 'waitFor', 'writeToStore']);
  });

  it.each(['bash', 'claudePrompt', 'claudeSession', 'customTool', 'calendarEvent'])('refuses a %s cell', (kind) => {
    expect(PlaybookCellSchema.safeParse({ id: 'a', kind, command: 'ls', prompt: 'x' }).success).toBe(false);
  });
});

describe('a script cell', () => {
  it('defaults args and env to empty', () => {
    const cell = PlaybookCellSchema.parse(scriptCell());

    expect(cell).toMatchObject({ args: [], env: {} });
  });

  it('keeps a secret token and a literal in env', () => {
    const cell = PlaybookCellSchema.parse(scriptCell({ env: { API_TOKEN: '{{secret:JIRA_TOKEN}}', MODE: 'fast' } }));

    expect(cell).toMatchObject({ env: { API_TOKEN: '{{secret:JIRA_TOKEN}}', MODE: 'fast' } });
  });

  it('refuses an env name that is not an identifier', () => {
    expect(PlaybookCellSchema.safeParse(scriptCell({ env: { 'BAD NAME': 'x' } })).success).toBe(false);
  });

  it('holds 64 arguments and refuses the 65th', () => {
    expect(PlaybookCellSchema.safeParse(scriptCell({ args: manyOf(MAX_SCRIPT_ARGUMENTS, () => 'a') })).success).toBe(true);
    expect(PlaybookCellSchema.safeParse(scriptCell({ args: manyOf(MAX_SCRIPT_ARGUMENTS + 1, () => 'a') })).success).toBe(false);
  });

  it('refuses an argument over 4096 characters and an unknown field', () => {
    expect(PlaybookCellSchema.safeParse(scriptCell({ args: ['a'.repeat(4097)] })).success).toBe(false);
    expect(PlaybookCellSchema.safeParse(scriptCell({ command: 'rm -rf /' })).success).toBe(false);
  });
});

describe('the other cells', () => {
  it('bounds a manual prompt to 8192 characters and refuses a blank one', () => {
    expect(PlaybookCellSchema.safeParse({ id: 'm', kind: 'manual', prompt: 'p'.repeat(8192) }).success).toBe(true);
    expect(PlaybookCellSchema.safeParse({ id: 'm', kind: 'manual', prompt: 'p'.repeat(8193) }).success).toBe(false);
    expect(PlaybookCellSchema.safeParse({ id: 'm', kind: 'manual', prompt: '   ' }).success).toBe(false);
  });

  it('refuses a header name with a line break and a method outside the list', () => {
    const http = { id: 'h', kind: 'http', method: 'GET', url: 'https://example.com' };

    expect(PlaybookCellSchema.safeParse({ ...http, headers: { 'X-A\nB': 'v' } }).success).toBe(false);
    expect(PlaybookCellSchema.safeParse({ ...http, method: 'TRACE' }).success).toBe(false);
  });

  it('counts the bytes of tool input in UTF-8: 6000 kanji are 18000 bytes, over the 16384 cap', () => {
    const tool = (query: string) => ({ id: 't', kind: 'tool', tool: 'list_notes', input: { query } });

    expect(PlaybookCellSchema.safeParse(tool('a'.repeat(6000))).success).toBe(true);
    expect(PlaybookCellSchema.safeParse(tool('漢'.repeat(6000))).success).toBe(false);
  });

  it('refuses tool input nested deeper than 6 levels', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };

    expect(PlaybookCellSchema.safeParse({ id: 't', kind: 'tool', tool: 'list_notes', input: { ok: 1 } }).success).toBe(true);
    expect(PlaybookCellSchema.safeParse({ id: 't', kind: 'tool', tool: 'list_notes', input: deep }).success).toBe(false);
  });

  it('needs at least one condition in a waitFor predicate', () => {
    expect(PlaybookCellSchema.safeParse({ id: 'w', kind: 'waitFor', predicate: [] }).success).toBe(false);
    expect(PlaybookCellSchema.safeParse({ id: 'w', kind: 'waitFor', predicate: [{ lhs: 'steps.a.ok', op: 'eq', rhs: true }] }).success).toBe(true);
  });

  it('types the outputs string, number, bool or json only', () => {
    expect(PlaybookCellSchema.safeParse(scriptCell({ outputs: { status: 'number', body: 'json' } })).success).toBe(true);
    expect(PlaybookCellSchema.safeParse(scriptCell({ outputs: { status: 'integer' } })).success).toBe(false);
  });

  it('refuses a forEach that is not an inputs or steps path', () => {
    expect(PlaybookCellSchema.safeParse(scriptCell({ next: [{ to: 'x', forEach: 'steps.a.items' }] })).success).toBe(true);
    expect(PlaybookCellSchema.safeParse(scriptCell({ next: [{ to: 'x', forEach: 'item' }] })).success).toBe(false);
  });
});

describe('the flow', () => {
  it('holds 200 cells and refuses the 201st', () => {
    const cells = (count: number) => manyOf(count, (position) => scriptCell({ id: `c${position}` }));

    expect(PlaybookFlowSchema.safeParse({ cells: cells(MAX_PLAYBOOK_CELLS) }).success).toBe(true);
    expect(PlaybookFlowSchema.safeParse({ cells: cells(MAX_PLAYBOOK_CELLS + 1) }).success).toBe(false);
  });

  it('refuses a cell id with a dot, which would break {{steps.id.field}}', () => {
    expect(PlaybookCellSchema.safeParse(scriptCell({ id: 'a.b' })).success).toBe(false);
  });
});

describe('the inputs and the policy', () => {
  it('refuses two inputs with the same name', () => {
    expect(PlaybookInputsSchema.safeParse([{ name: 'a', type: 'string' }, { name: 'a', type: 'number' }]).success).toBe(false);
  });

  it('defaults the policy to no allowed host, no auto grant, no auto distill and 50 runs kept', () => {
    expect(PlaybookPolicySchema.parse({})).toEqual({ allowedHosts: [], browserAutoGrant: false, autoDistill: false, maxRunsToKeep: 50 });
  });

  it.each(['*.example.com', 'Example.com', 'example.com:443', 'user@example.com', 'example.com/path', 'exa mple.com', '', '-bad.example.com', 'bücher.example'])(
    'refuses the allowed host %j', (host) => {
      expect(PlaybookPolicySchema.safeParse({ allowedHosts: [host] }).success).toBe(false);
    });

  it.each(['example.com', 'api.example.com', 'xn--bcher-kva.example', '127.0.0.1'])('accepts the allowed host %s', (host) => {
    expect(PlaybookPolicySchema.parse({ allowedHosts: [host] }).allowedHosts).toEqual([host]);
  });

  it('refuses more than 32 allowed hosts', () => {
    const tooMany = Array.from({ length: 33 }, (_, position) => `h${position}.example.com`);
    expect(PlaybookPolicySchema.safeParse({ allowedHosts: tooMany }).success).toBe(false);
  });
});
