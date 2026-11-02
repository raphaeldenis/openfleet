import { describe, expect, it } from 'vitest';
import { categoryLabelOf, claudeCodeNameOf, domainLabelOf } from './tool-display';

describe('tool display', () => {
  it('writes a domain id as words with a capital first letter', () => {
    expect(domainLabelOf('data_stores')).toBe('Data stores');
    expect(domainLabelOf('notes')).toBe('Notes');
  });

  it.each([
    ['read_only', 'Read only'],
    ['additive', 'Additive'],
    ['destructive', 'Destructive'],
    ['execution_external', 'Runs externally'],
  ] as const)('labels the %s category "%s"', (category, label) => {
    expect(categoryLabelOf(category)).toBe(label);
  });

  it('gives the name Claude Code shows for a tool of the openfleet MCP server', () => {
    expect(claudeCodeNameOf('create_session')).toBe('mcp__openfleet__create_session');
  });
});
