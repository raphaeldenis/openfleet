import { MAX_HOOK_LIST_ENTRIES, MAX_TODO_ITEMS, TODO_TOOL_NAMES, type ClaudeHookEvent, type TodoToolName } from '@openfleet/shared';
import type { ZodError } from 'zod';
import { normalisedTodoText } from './todoText.js';

const MAX_TOOL_USE_ID_LENGTH = 128;
/** A status or an id is only ever compared with a short token, so a longer value is never read. */
const SHORT_TOKEN_HEAD_LENGTH = 64;

export type TodoTaskId = string | number;

export interface TodoEntry { id?: TodoTaskId; subject?: string; status?: string }
export interface TodoWriteEntry { content?: string; status?: string; activeForm?: string }

/** The scalars the reducer reads from a call's input, texts already normalised and masked; everything else in the input is never read. */
export interface TodoCallInput {
  subject?: string;
  activeForm?: string;
  status?: string;
  taskId?: TodoTaskId;
  todos?: TodoWriteEntry[];
  todosBeyondCap?: number;
}

/** The scalars the reducer reads from a call's result (`toolUseResult` in a transcript, `tool_response` in a hook). */
export interface TodoCallResponse {
  task?: { id?: TodoTaskId; subject?: string };
  taskId?: TodoTaskId;
  success?: boolean;
  toStatus?: string;
  tasks?: TodoEntry[];
  tasksBeyondCap?: number;
}

export interface NarrowedTodoCall { input: TodoCallInput; response: TodoCallResponse | undefined }
export interface TodoHookCall extends NarrowedTodoCall { toolUseId: string; name: TodoToolName }

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTodoToolName = (name: unknown): name is TodoToolName => (TODO_TOOL_NAMES as readonly unknown[]).includes(name);

const textOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = normalisedTodoText(value);
  return text.length > 0 ? text : undefined;
};
const headOfShortToken = (value: unknown): string | undefined => (typeof value === 'string' ? value.slice(0, SHORT_TOKEN_HEAD_LENGTH) : undefined);
const idOf = (value: unknown): TodoTaskId | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : headOfShortToken(value));
const flagOf = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

/** Builds an object holding only the defined entries, so `toEqual` and JSON see exactly what was read. */
const withoutUndefined = <T extends object>(entries: T): T => Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as T;

const firstEntriesOf = <T>(list: unknown, limit: number, readEntry: (entry: unknown) => T): { entries: T[]; beyondCap: number } | undefined => {
  if (!Array.isArray(list)) return undefined;
  const entries = list.slice(0, limit).map(readEntry);
  return { entries, beyondCap: Math.max(0, list.length - limit) };
};

const todoEntryOf = (entry: unknown): TodoEntry => {
  if (!isPlainObject(entry)) return {};
  return withoutUndefined({ id: idOf(entry.id), subject: textOf(entry.subject), status: headOfShortToken(entry.status) });
};

const todoWriteEntryOf = (entry: unknown): TodoWriteEntry => {
  if (!isPlainObject(entry)) return {};
  return withoutUndefined({ content: textOf(entry.content), status: headOfShortToken(entry.status), activeForm: textOf(entry.activeForm) });
};

const narrowedInput = (input: unknown): TodoCallInput => {
  if (!isPlainObject(input)) return {};
  const todos = firstEntriesOf(input.todos, MAX_TODO_ITEMS, todoWriteEntryOf);
  return withoutUndefined({
    subject: textOf(input.subject),
    activeForm: textOf(input.activeForm),
    status: headOfShortToken(input.status),
    taskId: idOf(input.taskId),
    todos: todos?.entries,
    todosBeyondCap: todos && todos.beyondCap > 0 ? todos.beyondCap : undefined,
  });
};

const narrowedResponse = (response: unknown): TodoCallResponse | undefined => {
  if (!isPlainObject(response)) return undefined;
  const { task, statusChange } = response;
  const tasks = firstEntriesOf(response.tasks, MAX_HOOK_LIST_ENTRIES, todoEntryOf);
  return withoutUndefined({
    task: isPlainObject(task) ? withoutUndefined({ id: idOf(task.id), subject: textOf(task.subject) }) : undefined,
    taskId: idOf(response.taskId),
    success: flagOf(response.success),
    toStatus: isPlainObject(statusChange) ? headOfShortToken(statusChange.to) : undefined,
    tasks: tasks?.entries,
    tasksBeyondCap: tasks && tasks.beyondCap > 0 ? tasks.beyondCap : undefined,
  });
};

/** Reads the capped scalars of one todo call, from either source. Never throws; the caller has already checked the tool name. */
export function narrowTodoCall(rawInput: unknown, rawResponse: unknown): NarrowedTodoCall {
  return { input: narrowedInput(rawInput), response: narrowedResponse(rawResponse) };
}

type PostToolUseEvent = Extract<ClaudeHookEvent, { hook_event_name: 'PostToolUse' }>;

/**
 * Narrows a PostToolUse hook event to a todo call. Returns undefined, reading nothing of the payload, for any other tool; returns undefined
 * for a call that cannot be deduplicated (no usable `tool_use_id`) and for a payload that throws when read.
 */
export function narrowTodoHookCall(event: Pick<PostToolUseEvent, 'tool_name' | 'tool_use_id' | 'tool_input' | 'tool_response'>): TodoHookCall | undefined {
  try {
    const name = event.tool_name;
    if (!isTodoToolName(name)) return undefined;
    const toolUseId = event.tool_use_id;
    const hasUsableToolUseId = typeof toolUseId === 'string' && toolUseId.length > 0 && toolUseId.length <= MAX_TOOL_USE_ID_LENGTH;
    if (!hasUsableToolUseId) return undefined;
    return { toolUseId, name, ...narrowTodoCall(event.tool_input, event.tool_response) };
  } catch {
    return undefined;
  }
}

/** Returns the event without the two payload fields, so the state machine and the trackers never see a tool output. Any other event is returned as it is. */
export function withoutTodoPayload(event: ClaudeHookEvent): ClaudeHookEvent {
  if (event.hook_event_name !== 'PostToolUse') return event;
  const { tool_input: _toolInput, tool_response: _toolResponse, ...forwarded } = event;
  return forwarded;
}

/** Lists the issues of a failed hook parse by code and path only: a received value may hold a credential. */
export const zodIssueCodes = (error: ZodError): string[] => error.issues.map((issue) => `${issue.code}@${issue.path.join('.')}`);
