import { describe, expect, it } from 'vitest';
import { ClaudeHookEventSchema } from './hooks.js';
import {
  MAX_TODO_ITEMS,
  MAX_TODO_TEXT,
  SessionTodosSchema,
  TODO_TOOL_NAMES,
  TodoSummarySchema,
  type SessionTodos,
} from './todos.js';

const aSnapshot = (overrides: Partial<SessionTodos> = {}): SessionTodos => ({
  sessionId: 'session-1',
  items: [
    { id: '1', content: 'Review pull request', status: 'completed' },
    { id: '2', content: 'Update documentation', status: 'in_progress', activeForm: 'Updating documentation' },
  ],
  counts: { total: 2, completed: 1, inProgress: 1, pending: 0 },
  omitted: 0,
  source: 'task_tools',
  updatedAt: '2026-09-30T16:26:44.749Z',
  ...overrides,
});

describe('SessionTodosSchema', () => {
  it('accepts the snapshot of a session that planned two tasks', () => {
    expect(SessionTodosSchema.safeParse(aSnapshot()).success).toBe(true);
  });

  it('accepts the "nothing recorded" snapshot: no source, no date, no items', () => {
    const nothingRecorded = aSnapshot({ items: [], counts: { total: 0, completed: 0, inProgress: 0, pending: 0 }, source: null, updatedAt: null });
    expect(SessionTodosSchema.safeParse(nothingRecorded).success).toBe(true);
  });

  it('accepts the optional stale and incomplete flags and the unnamed placeholder row', () => {
    const flagged = aSnapshot({ stale: true, incomplete: true, items: [{ id: '2', content: 'Task #2', status: 'pending', unnamed: true }] });
    expect(SessionTodosSchema.safeParse(flagged).success).toBe(true);
  });

  it('refuses a status the panel cannot draw, such as deleted (a deleted task has no row)', () => {
    const withDeletedRow = aSnapshot({ items: [{ id: '1', content: 'x', status: 'deleted' as never }] });
    expect(SessionTodosSchema.safeParse(withDeletedRow).success).toBe(false);
  });

  it('refuses more than MAX_TODO_ITEMS items', () => {
    const tooMany = Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, index) => ({ id: String(index), content: 'x', status: 'pending' as const }));
    expect(SessionTodosSchema.safeParse(aSnapshot({ items: tooMany })).success).toBe(false);
  });

  it('refuses a text longer than MAX_TODO_TEXT characters', () => {
    const tooLong = aSnapshot({ items: [{ id: '1', content: 'x'.repeat(MAX_TODO_TEXT + 1), status: 'pending' }] });
    expect(SessionTodosSchema.safeParse(tooLong).success).toBe(false);
  });

  it('refuses an unnamed flag that is false: the flag is present only when true', () => {
    const falseFlag = aSnapshot({ items: [{ id: '1', content: 'x', status: 'pending', unnamed: false as never }] });
    expect(SessionTodosSchema.safeParse(falseFlag).success).toBe(false);
  });
});

describe('TodoSummarySchema', () => {
  it('accepts the counts of a session with its last update time', () => {
    const summary = { sessionId: 'session-1', counts: { total: 7, completed: 3, inProgress: 1, pending: 3 }, updatedAt: '2026-09-30T16:26:44.749Z' };
    expect(TodoSummarySchema.safeParse(summary).success).toBe(true);
  });
});

describe('TODO_TOOL_NAMES', () => {
  it('lists the tools whose calls change the list, and not TaskGet', () => {
    expect([...TODO_TOOL_NAMES]).toEqual(['TaskCreate', 'TaskUpdate', 'TaskList', 'TodoWrite']);
  });
});

describe('the PostToolUse hook body', () => {
  const postToolUse = { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'TaskCreate', tool_use_id: 'toolu_1' };

  it('carries tool_input and tool_response through the schema when the CLI sends them', () => {
    const parsed = ClaudeHookEventSchema.parse({ ...postToolUse, tool_input: { subject: 'x' }, tool_response: { task: { id: '1' } } });
    expect(parsed).toMatchObject({ tool_input: { subject: 'x' }, tool_response: { task: { id: '1' } } });
  });

  it('still parses an older body without the two fields', () => {
    expect(ClaudeHookEventSchema.safeParse(postToolUse).success).toBe(true);
  });

  it('still parses a body whose tool_response is not an object (a Bash output is a string)', () => {
    expect(ClaudeHookEventSchema.safeParse({ ...postToolUse, tool_name: 'Bash', tool_input: 'ls', tool_response: 'out' }).success).toBe(true);
  });
});
