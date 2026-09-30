import { z } from 'zod';

export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_SOURCES = ['task_tools', 'todo_write'] as const;
export type TodoSource = (typeof TODO_SOURCES)[number];

/** The tools whose completed calls change the list. `TaskGet` is deliberately absent: its result shape is unobserved. */
export const TODO_TOOL_NAMES = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TodoWrite'] as const;
export type TodoToolName = (typeof TODO_TOOL_NAMES)[number];

export const MAX_TODO_ITEMS = 100;
export const MAX_TRACKED_TASKS = 500;
export const MAX_TODO_TEXT = 200;
export const MAX_PENDING_CALLS = 100;
export const MAX_HOOK_LIST_ENTRIES = MAX_TRACKED_TASKS;
export const MAX_QUEUED_HOOKS = 200;
export const SEEN_CALLS_KEPT = 2000;
export const TODO_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_FOLD_BYTES = 64 * 1024 * 1024;
export const TODO_GET_WAIT_MS = 2000;
export const EMIT_COALESCE_MS = 50;
export const CLOSED_SNAPSHOTS_KEPT = 50;

const TodoTextSchema = z.string().max(MAX_TODO_TEXT);

export const TodoItemSchema = z.object({
  id: z.string(),
  content: TodoTextSchema,
  status: z.enum(TODO_STATUSES),
  activeForm: TodoTextSchema.optional(),
  /** A placeholder row: an update named this id before any create or list did. */
  unnamed: z.literal(true).optional(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoCountsSchema = z.object({ total: z.number(), completed: z.number(), inProgress: z.number(), pending: z.number() });
export type TodoCounts = z.infer<typeof TodoCountsSchema>;

export const SessionTodosSchema = z.object({
  sessionId: z.string(),
  items: z.array(TodoItemSchema).max(MAX_TODO_ITEMS),
  counts: TodoCountsSchema,
  omitted: z.number(),
  source: z.enum(TODO_SOURCES).nullable(),
  updatedAt: z.string().nullable(),
  stale: z.literal(true).optional(),
  incomplete: z.literal(true).optional(),
});
export type SessionTodos = z.infer<typeof SessionTodosSchema>;

export const TodoSummarySchema = z.object({ sessionId: z.string(), counts: TodoCountsSchema, updatedAt: z.string() });
export type TodoSummary = z.infer<typeof TodoSummarySchema>;
