import { describe, expect, it } from 'vitest';
import type { Approval } from '@openfleet/shared';
import { PENDING_PERMISSION_INPUT_LIMIT, PENDING_PERMISSION_TRUNCATION_MARKER, pendingPermissionViewOf } from './pendingPermissionView.js';

const NOW = new Date('2026-10-29T10:00:30.000Z');
const approvalOf = (toolName: string, toolInput: unknown): Approval => ({ id: 'a1', sessionId: 's1', toolName, toolInput, status: 'pending', createdAt: '2026-10-29T10:00:00.000Z' });

describe('pendingPermissionViewOf', () => {
  it('shows the program of a Bash command, never its arguments, and the age in seconds', () => {
    const view = pendingPermissionViewOf(approvalOf('Bash', { command: 'gh pr merge 1' }), NOW);

    expect(view).toEqual({ toolName: 'Bash', ageSeconds: 30, input: 'gh' });
  });

  it('shows the name of a leading environment assignment, not its value', () => {
    const view = pendingPermissionViewOf(approvalOf('Bash', { command: 'API_KEY=ak_inv_55aa66bb77cc node run.js' }), NOW);

    expect(view.input).toBe('API_KEY=***');
  });

  it('keeps a multi-line command to its first word', () => {
    const view = pendingPermissionViewOf(approvalOf('Bash', { command: 'echo a\necho b' }), NOW);

    expect(view.input).toBe('echo');
  });

  it('stops the program name before a shell expansion so ${IFS} cannot smuggle arguments', () => {
    const view = pendingPermissionViewOf(approvalOf('Bash', { command: 'curl${IFS}-u${IFS}admin:hunter2pw' }), NOW);

    expect(view.input).toBe('curl');
  });

  it('reduces a raw string tool input to its first word', () => {
    const view = pendingPermissionViewOf(approvalOf('Bash', 'curl -u admin:hunter2pw https://x.test'), NOW);

    expect(view.input).toBe('curl');
  });

  it('treats an array command as Bash and shows its first element only', () => {
    const view = pendingPermissionViewOf(approvalOf('Bash', { command: ['rm', '-rf', 'secret-dir'] }), NOW);

    expect(view.input).toBe('rm');
  });

  it.each(['Read', 'Edit', 'Write'])('shows the file path for %s', (toolName) => {
    const view = pendingPermissionViewOf(approvalOf(toolName, { file_path: '/repo/a.ts', content: 'long body' }), NOW);

    expect(view.input).toBe('/repo/a.ts');
  });

  it('shows a short compact form for a tool that has no command and no path', () => {
    const view = pendingPermissionViewOf(approvalOf('mcp__scape__create_note', { title: 'T', body_md: 'x' }), NOW);

    expect(view.input).toBe('{"title":"T","body_md":"x"}');
  });

  it('caps a 5000-character input at the limit with a truncation marker', () => {
    const view = pendingPermissionViewOf(approvalOf('mcp__scape__create_note', { body_md: 'ab '.repeat(1700) }), NOW);

    expect(view.input.length).toBeLessThanOrEqual(PENDING_PERMISSION_INPUT_LIMIT + PENDING_PERMISSION_TRUNCATION_MARKER.length);
    expect(view.input.endsWith(PENDING_PERMISSION_TRUNCATION_MARKER)).toBe(true);
  });

  it('masks a secret held by a named field', () => {
    const view = pendingPermissionViewOf(approvalOf('mcp__x__login', { user: 'bob', password: 'hunter2' }), NOW);

    expect(view.input).not.toContain('hunter2');
  });

  it('masks before capping, so a secret cut by the limit does not leak its head', () => {
    const view = pendingPermissionViewOf(approvalOf('mcp__x__login', { note: 'x'.repeat(170), token: 'abcdefghijklmnop' }), NOW);

    expect(view.input).not.toContain('abcdef');
  });
});
