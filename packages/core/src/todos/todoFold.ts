import {
  MAX_PENDING_CALLS,
  MAX_TODO_ITEMS,
  MAX_TODO_TEXT,
  MAX_TRACKED_TASKS,
  SEEN_CALLS_KEPT,
  TODO_STATUSES,
  TODO_TOOL_NAMES,
  type SessionTodos,
  type TodoItem,
  type TodoSource,
  type TodoStatus,
  type TodoToolName,
} from '@openfleet/shared';
import { maskedSecrets, maskingCutCredential } from '../redact.js';
import { narrowTodoCall, TODO_TEXT_HEAD_LENGTH, type TodoCallInput, type TodoCallResponse, type TodoHookCall } from './todoHookCall.js';

const MAX_TRANSCRIPT_LINE_CHARS = 1024 * 1024;
const MAX_TOOL_USE_ID_LENGTH = 128;
const FUTURE_TOLERANCE_MS = 60_000;
const TASK_ID = /^[A-Za-z0-9_.:-]{1,32}$/;
const CREATED_TASK_ID_IN_RESULT_TEXT = /Task #(\d{1,9})\b/;
const DELETED_STATUS = 'deleted';
const ELLIPSIS = '…';

// C0 and C1 controls, DEL, line and paragraph separators, bidi marks, embeddings, overrides and isolates: each run of them, and any whitespace, becomes one space.
const CONTROL_CODE_POINT_RANGES: readonly (readonly [first: number, last: number])[] = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x200e, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069],
];
const codePointRange = ([first, last]: readonly [number, number]) => `\\u{${first.toString(16)}}-\\u{${last.toString(16)}}`;
const CONTROLS_AND_WHITESPACE = new RegExp(`[${CONTROL_CODE_POINT_RANGES.map(codePointRange).join('')}\\s]+`, 'gu');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

interface TaskRow { id: string; content: string; status: TodoStatus; activeForm?: string; unnamed?: true }
interface PendingCall { name: TodoToolName; input: TodoCallInput }

export interface TodoFold {
  readonly now: () => Date;
  readonly notBefore: Date | undefined;
  tasks: Map<string, TaskRow>;
  /** Tasks the fold could not store: they count as omitted, never as tracked. */
  untrackedTasks: number;
  /** The `tool_use_id`s already folded, oldest first: a call delivered by both sources folds once. */
  seenCalls: Set<string>;
  pendingCalls: Map<string, PendingCall>;
  source: TodoSource | null;
  updatedAt: string | null;
}

/** A todo call that succeeded, from either source: the input and the result are already paired. */
export interface CompletedCall {
  toolUseId: string;
  name: TodoToolName;
  input: TodoCallInput;
  response: TodoCallResponse | undefined;
  /** When the call completed, as the source states it. Used for `updatedAt` only when it is a plausible date. */
  at?: string;
}

export function createTodoFold(options: { now?: () => Date; notBefore?: Date } = {}): TodoFold {
  return {
    now: options.now ?? (() => new Date()),
    notBefore: options.notBefore,
    tasks: new Map(),
    untrackedTasks: 0,
    seenCalls: new Set(),
    pendingCalls: new Map(),
    source: null,
    updatedAt: null,
  };
}

type PlainObject = Record<string, unknown>;
const isPlainObject = (value: unknown): value is PlainObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTodoToolName = (name: unknown): name is TodoToolName => (TODO_TOOL_NAMES as readonly unknown[]).includes(name);
const isHighSurrogate = (codeUnit: number) => codeUnit >= 0xd800 && codeUnit <= 0xdbff;

const cutToMaxText = (text: string): string => {
  if (text.length <= MAX_TODO_TEXT) return text;
  const room = MAX_TODO_TEXT - ELLIPSIS.length;
  const cutsASurrogatePair = isHighSurrogate(text.charCodeAt(room - 1));
  return `${text.slice(0, cutsASurrogatePair ? room - 1 : room)}${ELLIPSIS}`;
};

/** Makes a todo text safe to store, log and draw: one line, no control or bidi character, masked, at most MAX_TODO_TEXT long. */
export function normalisedTodoText(raw: string): string {
  const wasCutByTheHead = raw.length >= TODO_TEXT_HEAD_LENGTH;
  const oneLine = raw.slice(0, TODO_TEXT_HEAD_LENGTH).replace(LONE_SURROGATE, '�').normalize('NFC').replace(CONTROLS_AND_WHITESPACE, ' ').trim();
  const withoutCutCredential = wasCutByTheHead ? maskingCutCredential(oneLine) : oneLine;
  return cutToMaxText(maskedSecrets(withoutCutCredential));
}

const optionalText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = normalisedTodoText(value);
  return text.length > 0 ? text : undefined;
};

const taskIdOf = (value: unknown): string | undefined => {
  const candidate = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof candidate === 'string' && TASK_ID.test(candidate) ? candidate : undefined;
};

const statusOf = (value: unknown): TodoStatus | undefined => TODO_STATUSES.find((status) => status === value);

const rowOf = (fields: { id: string; content: string; status: TodoStatus; activeForm?: string; unnamed?: true }): TaskRow => {
  const { activeForm, unnamed, ...required } = fields;
  return { ...required, ...(activeForm ? { activeForm } : {}), ...(unnamed ? { unnamed } : {}) };
};

const countOfExcess = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0);
const hasRoomForANewTask = (fold: TodoFold) => fold.tasks.size < MAX_TRACKED_TASKS;

const stampOf = (fold: TodoFold, at: string | undefined): string => {
  const now = fold.now();
  const claimedTime = typeof at === 'string' && at.length <= 64 ? Date.parse(at) : Number.NaN;
  const isNotInTheFuture = claimedTime <= now.getTime() + FUTURE_TOLERANCE_MS;
  const isNotBeforeTheSession = fold.notBefore === undefined || claimedTime >= fold.notBefore.getTime();
  const isPlausible = Number.isFinite(claimedTime) && isNotInTheFuture && isNotBeforeTheSession;
  return isPlausible ? new Date(claimedTime).toISOString() : now.toISOString();
};

type Applier = (fold: TodoFold, input: TodoCallInput, response: TodoCallResponse | undefined) => boolean;

const applyTaskCreate: Applier = (fold, input, response) => {
  const id = taskIdOf(response?.task?.id);
  if (id === undefined) return false;
  const content = optionalText(input.subject) ?? optionalText(response?.task?.subject);
  const activeForm = optionalText(input.activeForm);
  const existing = fold.tasks.get(id);
  if (existing) {
    if (content) {
      existing.content = content;
      delete existing.unnamed;
    }
    if (activeForm) existing.activeForm = activeForm;
    return true;
  }
  if (!content) return false;
  if (!hasRoomForANewTask(fold)) {
    fold.untrackedTasks += 1;
    return true;
  }
  fold.tasks.set(id, rowOf({ id, content, status: 'pending', activeForm }));
  return true;
};

const applyTaskUpdate: Applier = (fold, input, response) => {
  if (!response || response.success === false) return false;
  const id = taskIdOf(response.taskId) ?? taskIdOf(input.taskId);
  if (id === undefined) return false;
  const requestedStatus = typeof input.status === 'string' ? input.status : response.toStatus;
  if (requestedStatus === DELETED_STATUS) {
    fold.tasks.delete(id);
    return true;
  }
  const status = statusOf(requestedStatus);
  const subject = optionalText(input.subject);
  const activeForm = optionalText(input.activeForm);
  const existing = fold.tasks.get(id);
  if (existing) {
    if (status) existing.status = status;
    if (subject) {
      existing.content = subject;
      delete existing.unnamed;
    }
    if (activeForm) existing.activeForm = activeForm;
    return true;
  }
  if (!hasRoomForANewTask(fold)) {
    fold.untrackedTasks += 1;
    return true;
  }
  fold.tasks.set(id, rowOf({ id, content: subject ?? `Task #${id}`, status: status ?? 'pending', activeForm, unnamed: subject ? undefined : true }));
  return true;
};

const applyTaskList: Applier = (fold, _input, response) => {
  const listed = response?.tasks;
  if (!Array.isArray(listed)) return false;
  const entries = listed.slice(0, MAX_TRACKED_TASKS);
  const replacement = new Map<string, TaskRow>();
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    const id = taskIdOf(entry.id);
    const content = optionalText(entry.subject);
    const status = entry.status === DELETED_STATUS ? undefined : (statusOf(entry.status) ?? 'pending');
    if (id === undefined || content === undefined || status === undefined) continue;
    replacement.set(id, rowOf({ id, content, status, activeForm: fold.tasks.get(id)?.activeForm }));
  }
  fold.tasks = replacement;
  fold.untrackedTasks = Math.max(0, listed.length - entries.length) + countOfExcess(response?.tasksBeyondCap);
  return true;
};

const applyTodoWrite: Applier = (fold, input) => {
  const written = input.todos;
  if (!Array.isArray(written)) return false;
  const entries = written.slice(0, MAX_TRACKED_TASKS);
  const replacement = new Map<string, TaskRow>();
  entries.forEach((entry, position) => {
    if (!isPlainObject(entry)) return;
    const content = optionalText(entry.content);
    if (content === undefined) return;
    const id = String(position);
    replacement.set(id, rowOf({ id, content, status: statusOf(entry.status) ?? 'pending', activeForm: optionalText(entry.activeForm) }));
  });
  fold.tasks = replacement;
  fold.untrackedTasks = Math.max(0, written.length - entries.length) + countOfExcess(input.todosBeyondCap);
  return true;
};

const APPLIER_OF_TOOL: Record<TodoToolName, Applier> = {
  TaskCreate: applyTaskCreate,
  TaskUpdate: applyTaskUpdate,
  TaskList: applyTaskList,
  TodoWrite: applyTodoWrite,
};
const SOURCE_OF_TOOL: Record<TodoToolName, TodoSource> = { TaskCreate: 'task_tools', TaskUpdate: 'task_tools', TaskList: 'task_tools', TodoWrite: 'todo_write' };

const rememberCall = (fold: TodoFold, toolUseId: string): void => {
  fold.seenCalls.add(toolUseId);
  if (fold.seenCalls.size <= SEEN_CALLS_KEPT) return;
  const oldest = fold.seenCalls.values().next().value;
  if (oldest !== undefined) fold.seenCalls.delete(oldest);
};

/**
 * Folds one completed call into the list, once per `tool_use_id` whichever source delivers it first. Returns whether the call was applied.
 * Total over any input: a call it cannot use is dropped and is not remembered, so a later delivery of the same call can still fold.
 */
export function applyCompletedCall(fold: TodoFold, call: CompletedCall): boolean {
  try {
    if (!isPlainObject(call)) return false;
    const { toolUseId, name } = call;
    if (typeof toolUseId !== 'string' || toolUseId.length === 0 || !isTodoToolName(name)) return false;
    if (fold.seenCalls.has(toolUseId)) return false;
    const input = isPlainObject(call.input) ? call.input : {};
    const response = isPlainObject(call.response) ? call.response : undefined;
    const isApplied = APPLIER_OF_TOOL[name](fold, input, response);
    if (!isApplied) return false;
    rememberCall(fold, toolUseId);
    fold.source = SOURCE_OF_TOOL[name];
    fold.updatedAt = stampOf(fold, call.at);
    return true;
  } catch {
    return false;
  }
}

/** The hook adapter: the call carries its own input and result, and the daemon clock stamps it. */
export const foldHookPayload = (fold: TodoFold, call: TodoHookCall): boolean => applyCompletedCall(fold, call);

const parsedObjectOf = (line: string): PlainObject | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const contentBlocksOf = (record: PlainObject): PlainObject[] => {
  const content = isPlainObject(record.message) ? record.message.content : undefined;
  return Array.isArray(content) ? content.filter(isPlainObject) : [];
};

const textOfResultContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (isPlainObject(part) && typeof part.text === 'string' ? part.text : '')).join('\n');
};

const createdTaskOfResultText = (resultContent: unknown): TodoCallResponse | undefined => {
  const id = CREATED_TASK_ID_IN_RESULT_TEXT.exec(textOfResultContent(resultContent).slice(0, TODO_TEXT_HEAD_LENGTH))?.[1];
  return id === undefined ? undefined : { task: { id } };
};

const rememberPendingCall = (fold: TodoFold, block: PlainObject): void => {
  const { id, name } = block;
  const isTodoCall = block.type === 'tool_use' && isTodoToolName(name) && typeof id === 'string' && id.length > 0 && id.length <= MAX_TOOL_USE_ID_LENGTH;
  if (!isTodoCall || fold.seenCalls.has(id)) return;
  fold.pendingCalls.set(id, { name, input: narrowTodoCall(block.input, undefined).input });
  if (fold.pendingCalls.size <= MAX_PENDING_CALLS) return;
  const oldest = fold.pendingCalls.keys().next().value;
  if (oldest !== undefined) fold.pendingCalls.delete(oldest);
};

const settlePendingCall = (fold: TodoFold, block: PlainObject, record: PlainObject): void => {
  const toolUseId = block.tool_use_id;
  if (block.type !== 'tool_result' || typeof toolUseId !== 'string') return;
  const pending = fold.pendingCalls.get(toolUseId);
  if (!pending) return;
  fold.pendingCalls.delete(toolUseId);
  if (block.is_error === true) return;
  const response = narrowTodoCall(undefined, record.toolUseResult).response ?? (pending.name === 'TaskCreate' ? createdTaskOfResultText(block.content) : undefined);
  applyCompletedCall(fold, { toolUseId, name: pending.name, input: pending.input, response, at: typeof record.timestamp === 'string' ? record.timestamp : undefined });
};

const mightConcernTheList = (fold: TodoFold, line: string): boolean => {
  const namesATodoTool = TODO_TOOL_NAMES.some((name) => line.includes(name));
  const mayHoldAPendingResult = fold.pendingCalls.size > 0 && line.includes('"tool_result"');
  return namesATodoTool || mayHoldAPendingResult;
};

const foldTranscriptLine = (fold: TodoFold, line: string): void => {
  if (line.length === 0 || line.length > MAX_TRANSCRIPT_LINE_CHARS || !mightConcernTheList(fold, line)) return;
  const record = parsedObjectOf(line);
  const isMainChain = record !== undefined && record.isSidechain !== true;
  if (!isMainChain) return;
  const blocks = contentBlocksOf(record);
  if (record.type === 'assistant') blocks.forEach((block) => rememberPendingCall(fold, block));
  if (record.type === 'user') blocks.forEach((block) => settlePendingCall(fold, block, record));
};

/** The transcript adapter: pairs each todo `tool_use` with its `tool_result` by id (results come back out of order) and folds the paired call. */
export function foldTranscriptText(fold: TodoFold, text: string): void {
  try {
    if (typeof text !== 'string') return;
    text.split('\n').forEach((line) => foldTranscriptLine(fold, line));
  } catch {
    // The line parsers are total; this net keeps a fault in one chunk from reaching the caller, whose next catch-up read repairs the list.
  }
}

const toItem = (row: TaskRow): TodoItem => ({ ...row });

export function snapshotOf(fold: TodoFold, sessionId: string): SessionTodos {
  const rows = [...fold.tasks.values()];
  const countOf = (status: TodoStatus) => rows.filter((row) => row.status === status).length;
  const items = rows.slice(0, MAX_TODO_ITEMS).map(toItem);
  const hasUnnamedRow = rows.some((row) => row.unnamed === true);
  return {
    sessionId,
    items,
    counts: { total: rows.length, completed: countOf('completed'), inProgress: countOf('in_progress'), pending: countOf('pending') },
    omitted: rows.length - items.length + fold.untrackedTasks,
    source: fold.source,
    updatedAt: fold.updatedAt,
    ...(hasUnnamedRow ? { incomplete: true as const } : {}),
  };
}
