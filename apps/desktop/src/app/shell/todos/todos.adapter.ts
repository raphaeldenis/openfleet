// The only file that knows where the todo types come from. TODOS-01 publishes them in
// `@openfleet/shared`; swapping to them is replacing this file's body with
// `export type { SessionTodos, TodoCounts, TodoItem, TodoStatus } from '@openfleet/shared';`
// (and MAX_TODO_ITEMS re-exported the same way).

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
  unnamed?: true;
}

export interface TodoCounts { total: number; completed: number; inProgress: number; pending: number }

export interface SessionTodos {
  sessionId: string;
  items: TodoItem[];
  counts: TodoCounts;
  omitted: number;
  source: 'task_tools' | 'todo_write' | null;
  updatedAt: string | null;
  stale?: true;
  incomplete?: true;
}

export const MAX_TODO_ITEMS = 100;
