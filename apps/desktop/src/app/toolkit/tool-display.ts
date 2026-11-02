import type { ToolCategory } from '@openfleet/shared';

const CATEGORY_LABELS: Readonly<Record<ToolCategory, string>> = {
  read_only: 'Read only',
  additive: 'Additive',
  destructive: 'Destructive',
  execution_external: 'Runs externally',
};

const OPENFLEET_SERVER_NAME_IN_CLAUDE_CODE = 'mcp__openfleet__';

export const categoryLabelOf = (category: ToolCategory): string => CATEGORY_LABELS[category];

export function domainLabelOf(domain: string): string {
  const words = domain.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const claudeCodeNameOf = (toolName: string): string => `${OPENFLEET_SERVER_NAME_IN_CLAUDE_CODE}${toolName}`;
