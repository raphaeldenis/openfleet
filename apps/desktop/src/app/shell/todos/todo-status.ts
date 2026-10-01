import type { TodoStatus } from './todos.adapter';

/** What a row shows for a status a newer daemon sent that this app does not know. */
export const UNKNOWN_STATUS_PRESENTATION = { glyph: '•', label: 'Other' } as const;

export const TODO_STATUS_PRESENTATION: Readonly<Record<TodoStatus, { glyph: string; label: string }>> = {
  completed: { glyph: '✓', label: 'Done' },
  in_progress: { glyph: '▶', label: 'In progress' },
  pending: { glyph: '○', label: 'Pending' },
};
