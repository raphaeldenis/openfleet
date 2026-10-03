import { MAX_TODO_ITEMS, SessionTodosSchema, TodoItemSchema } from '@openfleet/shared';
import type { SessionTodos, TodoItem, TodoStatus } from '@openfleet/shared';

const ANY_TEXT = TodoItemSchema.shape.id;
const ItemWithAnyStatusSchema = TodoItemSchema.extend({ status: ANY_TEXT });
const ListWithoutItemsSchema = SessionTodosSchema.omit({ items: true });

/** A status a newer daemon added stays on the item: the row reads it as "Other". */
function readableItem(candidate: unknown): TodoItem[] {
  const result = ItemWithAnyStatusSchema.safeParse(candidate);
  return result.success ? [{ ...result.data, status: result.data.status as TodoStatus }] : [];
}

function itemsOf(payload: unknown): unknown[] | undefined {
  const items = typeof payload === 'object' && payload !== null ? (payload as { items?: unknown }).items : undefined;
  const isListWithinCap = Array.isArray(items) && items.length <= MAX_TODO_ITEMS;
  return isListWithinCap ? items : undefined;
}

/** Reads a todo list from a daemon payload, dropping the items it cannot read; returns undefined when the payload itself is not a list. */
export function parseSessionTodos(payload: unknown): SessionTodos | undefined {
  const items = itemsOf(payload);
  const header = ListWithoutItemsSchema.safeParse(payload);
  if (items === undefined || !header.success) return undefined;
  return { ...header.data, items: items.flatMap(readableItem) };
}
