import type { PolicyRequest } from '@openfleet/shared';

export const policyRequest = (overrides: Partial<PolicyRequest> = {}): PolicyRequest => ({
  sessionId: 'session-1',
  harness: 'claude-cli',
  presence: 'unattended',
  actor: 'session',
  source: 'pre_tool_use',
  toolName: 'Bash',
  cwd: '/work/repo',
  scratchRoots: [],
  ...overrides,
});

export const bashRequest = (command: string, overrides: Partial<PolicyRequest> = {}): PolicyRequest =>
  policyRequest({ command, ...overrides });

export const fileToolRequest = (toolName: string, filePath: string, overrides: Partial<PolicyRequest> = {}): PolicyRequest =>
  policyRequest({ toolName, filePaths: [filePath], ...overrides });
