import { readFileSync } from 'node:fs';
import { ClaudeHookEventSchema, MAX_HOOK_LIST_ENTRIES, MAX_TODO_ITEMS, MAX_TODO_TEXT, type ClaudeHookEvent } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { narrowTodoHookCall, withoutTodoPayload, zodIssueCodes } from './todoHookCall.js';

const realHookBodies = readFileSync(new URL('./__fixtures__/hook-post-tool-use-1.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const [createOfReview, , , updateToCompleted] = realHookBodies;

const postToolUse = (fields: Record<string, unknown>) => ({ session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', ...fields }) as Extract<ClaudeHookEvent, { hook_event_name: 'PostToolUse' }>;

describe('narrowTodoHookCall on the real hook bodies', () => {
  it('keeps the subject and the created id of a TaskCreate and drops the description', () => {
    const call = narrowTodoHookCall(ClaudeHookEventSchema.parse(createOfReview) as never);

    expect(call).toEqual({
      toolUseId: 'toolu_01A1a9XHpZ9X7qoZNNFFPu1r',
      name: 'TaskCreate',
      input: { subject: 'Review user feedback' },
      response: { task: { id: '1', subject: 'Review user feedback' } },
    });
  });

  it('keeps the task id and the new status of a TaskUpdate', () => {
    const call = narrowTodoHookCall(ClaudeHookEventSchema.parse(updateToCompleted) as never);

    expect(call).toEqual({
      toolUseId: 'toolu_019o2syzDthSHQxxDtqSvEY6',
      name: 'TaskUpdate',
      input: { taskId: '1', status: 'completed' },
      response: { success: true, taskId: '1', toStatus: 'completed' },
    });
  });
});

describe('narrowTodoHookCall on the other todo shapes', () => {
  it('keeps id, subject and status of every TaskList entry and drops blockedBy', () => {
    const call = narrowTodoHookCall(
      postToolUse({ tool_name: 'TaskList', tool_input: {}, tool_response: { tasks: [{ id: '1', subject: 'A', status: 'completed', blockedBy: ['2'] }] } }),
    );

    expect(call?.response).toEqual({ tasks: [{ id: '1', subject: 'A', status: 'completed' }] });
  });

  it('keeps the content, status and activeForm of every TodoWrite entry (synthetic shape)', () => {
    const call = narrowTodoHookCall(
      postToolUse({ tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'A', status: 'in_progress', activeForm: 'Doing A', priority: 'high' }] }, tool_response: {} }),
    );

    expect(call?.input).toEqual({ todos: [{ content: 'A', status: 'in_progress', activeForm: 'Doing A' }] });
  });

  it('reads the activeForm and a numeric taskId of an update', () => {
    const call = narrowTodoHookCall(postToolUse({ tool_name: 'TaskUpdate', tool_input: { taskId: 7, activeForm: 'Fixing' }, tool_response: { success: true, taskId: 7 } }));

    expect(call?.input).toEqual({ taskId: 7, activeForm: 'Fixing' });
  });
});

describe('narrowTodoHookCall never reads what a todo call does not need', () => {
  const eventWhoseFieldThrowsWhenRead = (toolName: string, field: string) =>
    Object.defineProperty({ session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', tool_name: toolName }, field, {
      enumerable: true,
      get() {
        throw new Error(`${field} was read`);
      },
    }) as never;

  it('does not touch tool_input or tool_response of a Bash call', () => {
    expect(narrowTodoHookCall(eventWhoseFieldThrowsWhenRead('Bash', 'tool_response'))).toBeUndefined();
  });

  it('ignores TaskGet: its result shape is unobserved', () => {
    expect(narrowTodoHookCall(eventWhoseFieldThrowsWhenRead('TaskGet', 'tool_response'))).toBeUndefined();
  });

  it('returns undefined instead of throwing when reading the payload of a todo call throws', () => {
    expect(narrowTodoHookCall(eventWhoseFieldThrowsWhenRead('TaskCreate', 'tool_input'))).toBeUndefined();
  });

  it.each([
    ['is missing', undefined],
    ['is a number', 42],
    ['is 129 characters long', 'x'.repeat(129)],
    ['is empty', ''],
  ])('returns undefined when tool_use_id %s: a call that cannot be deduplicated is not folded', (_case, toolUseId) => {
    const call = narrowTodoHookCall(postToolUse({ tool_name: 'TaskCreate', tool_use_id: toolUseId, tool_input: { subject: 'A' }, tool_response: { task: { id: '1' } } }));

    expect(call).toBeUndefined();
  });
});

describe('narrowTodoHookCall on hostile payloads', () => {
  const narrowedResponse = (toolResponse: unknown) => narrowTodoHookCall(postToolUse({ tool_name: 'TaskCreate', tool_input: { subject: 'A' }, tool_response: toolResponse }))?.response;

  it.each([['null', null], ['a string', 'Task #1 created'], ['an array', [1, 2]], ['a number', 7], ['undefined', undefined]])(
    'yields a call without response when tool_response is %s',
    (_case, toolResponse) => {
      expect(narrowedResponse(toolResponse)).toBeUndefined();
    },
  );

  it('drops a task id that is an object and a tasks field that is not an array', () => {
    expect(narrowedResponse({ task: { id: { $gt: '' }, subject: 'A' } })).toEqual({ task: { subject: 'A' } });
    const list = narrowTodoHookCall(postToolUse({ tool_name: 'TaskList', tool_input: {}, tool_response: { tasks: 'nope' } }));
    expect(list?.response).toEqual({});
  });

  it('drops a subject that is an object', () => {
    const call = narrowTodoHookCall(postToolUse({ tool_name: 'TaskCreate', tool_input: { subject: { a: 1 } }, tool_response: { task: { id: '1' } } }));

    expect(call?.input).toEqual({});
  });

  it('cuts a 5 MiB subject to MAX_TODO_TEXT before anything else can read it', () => {
    const call = narrowTodoHookCall(postToolUse({ tool_name: 'TaskCreate', tool_input: { subject: 'a'.repeat(5 * 1024 * 1024) }, tool_response: { task: { id: '1' } } }));

    expect(call?.input.subject).toHaveLength(MAX_TODO_TEXT);
  });

  it('holds no credential in clear: every text of the input and of the result leaves narrowing masked', () => {
    const key = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123';
    const create = narrowTodoHookCall(postToolUse({ tool_name: 'TaskCreate', tool_input: { subject: `rotate ${key}`, activeForm: `rotating ${key}` }, tool_response: { task: { id: '1', subject: `rotate ${key}` } } }));
    const write = narrowTodoHookCall(postToolUse({ tool_name: 'TodoWrite', tool_input: { todos: [{ content: `rotate ${key}`, status: 'pending', activeForm: `rotating ${key}` }] }, tool_response: {} }));
    const list = narrowTodoHookCall(postToolUse({ tool_name: 'TaskList', tool_input: {}, tool_response: { tasks: [{ id: '1', subject: `rotate ${key}`, status: 'pending' }] } }));

    expect(JSON.stringify([create, write, list])).not.toContain('AbCdEf');
  });

  it('reads the first MAX_TODO_ITEMS entries of a TodoWrite and counts the rest', () => {
    const todos = Array.from({ length: 600 }, (_, index) => ({ content: `T${index}`, status: 'pending' }));

    const call = narrowTodoHookCall(postToolUse({ tool_name: 'TodoWrite', tool_input: { todos }, tool_response: {} }));

    expect(call?.input.todos).toHaveLength(MAX_TODO_ITEMS);
    expect(call?.input.todosBeyondCap).toBe(600 - MAX_TODO_ITEMS);
  });

  it('reads the first MAX_HOOK_LIST_ENTRIES entries of a 10 000-entry list and counts the rest', () => {
    const tasks = Array.from({ length: 10_000 }, (_, index) => ({ id: String(index), subject: `T${index}`, status: 'pending' }));

    const call = narrowTodoHookCall(postToolUse({ tool_name: 'TaskList', tool_input: {}, tool_response: { tasks } }));

    expect(call?.response?.tasks).toHaveLength(MAX_HOOK_LIST_ENTRIES);
    expect(call?.response?.tasksBeyondCap).toBe(10_000 - MAX_HOOK_LIST_ENTRIES);
  });

  it('never recurses into a payload nested 10 000 levels deep', () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 10_000; depth += 1) nested = { a: nested };

    const call = narrowTodoHookCall(postToolUse({ tool_name: 'TaskCreate', tool_input: { subject: 'A', extra: nested }, tool_response: { task: { id: '1' }, extra: nested } }));

    expect(call).toEqual({ toolUseId: 'toolu_1', name: 'TaskCreate', input: { subject: 'A' }, response: { task: { id: '1' } } });
  });

  it('keeps a __proto__ task id as a plain string for the reducer to judge', () => {
    const call = narrowTodoHookCall(postToolUse({ tool_name: 'TaskUpdate', tool_input: { taskId: '__proto__', status: 'completed' }, tool_response: { success: true, taskId: '__proto__' } }));

    expect(call?.input.taskId).toBe('__proto__');
    expect(Object.getPrototypeOf(call?.input)).toBe(Object.prototype);
  });
});

describe('withoutTodoPayload', () => {
  it('removes tool_input and tool_response from a PostToolUse event and keeps everything else', () => {
    const event = postToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'x'.repeat(1000) });

    const forwarded = withoutTodoPayload(event);

    expect(forwarded).toEqual({ session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', tool_name: 'Bash' });
    expect('tool_input' in forwarded || 'tool_response' in forwarded).toBe(false);
  });

  it('does not mutate the event it was given', () => {
    const event = postToolUse({ tool_name: 'TaskCreate', tool_input: { subject: 'A' }, tool_response: { task: { id: '1' } } });

    withoutTodoPayload(event);

    expect(event.tool_input).toEqual({ subject: 'A' });
  });

  it('returns any other event as it is, PreToolUse tool_input included', () => {
    const preToolUse = ClaudeHookEventSchema.parse({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });

    expect(withoutTodoPayload(preToolUse)).toBe(preToolUse);
  });
});

describe('zodIssueCodes', () => {
  it('describes a failed hook parse by issue code and path, never by the received value', () => {
    const result = ClaudeHookEventSchema.safeParse({ session_id: 12345, hook_event_name: 'PostToolUse', tool_name: 'Bearer abc123secret', tool_input: { subject: 'Bearer abc123secret' } });
    if (result.success) throw new Error('the body should not parse');

    const description = zodIssueCodes(result.error).join(' ');

    expect(description).toContain('invalid_type@session_id');
    expect(description).not.toContain('abc123secret');
    expect(description).not.toContain('12345');
  });

  it('lists exactly one code@path entry per issue, with no message text', () => {
    const result = ClaudeHookEventSchema.safeParse({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 42 });
    if (result.success) throw new Error('the body should not parse');

    expect(zodIssueCodes(result.error)).toEqual(['invalid_type@tool_name']);
  });
});
