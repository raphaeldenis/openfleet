import type { TodoStatus } from './todos.adapter';

export const TODO_STATUS_PRESENTATION: Readonly<Record<TodoStatus, { glyph: string; label: string }>> = {
  completed: { glyph: '✓', label: 'Done' },
  in_progress: { glyph: '▶', label: 'In progress' },
  pending: { glyph: '○', label: 'Pending' },
};
