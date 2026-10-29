import type { Approval } from '@openfleet/shared';
import { maskedSecrets } from '../redact.js';

export const PENDING_PERMISSION_INPUT_LIMIT = 200;
export const PENDING_PERMISSION_TRUNCATION_MARKER = '…[truncated]';

export interface PendingPermissionView {
  toolName: string;
  ageSeconds: number;
  input: string;
}

const FILE_TOOLS_PATH_FIELDS = ['file_path', 'notebook_path'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringFieldOf = (toolInput: unknown, fields: string[]): string | undefined => {
  if (!isRecord(toolInput)) return undefined;
  return fields.map((field) => toolInput[field]).find((value): value is string => typeof value === 'string');
};

const compactFormOf = (toolInput: unknown): string => {
  if (toolInput === undefined || toolInput === null) return '';
  return typeof toolInput === 'string' ? toolInput : (JSON.stringify(toolInput) ?? '');
};

const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ');

/** The program a command starts, never its arguments: `maskedSecrets` does not hide a bare password argument (`--password x`, `-pSECRET`) or a bare base64 key, so a command is not shown beyond its first word. An environment assignment (`API_KEY=x node`) shows its name only. */
const SHELL_METACHARACTER = /[$`;|&<>()'"\\]/;

const firstWordOf = (command: string): string => {
  const [firstWord = ''] = command.trim().split(/\s+/);
  const nameBeforeAssignment = firstWord.split('=')[0] ?? '';
  if (firstWord.includes('=')) return `${nameBeforeAssignment}=`;
  const [programName = ''] = firstWord.split(SHELL_METACHARACTER);
  return programName;
};

/** A `command` key is a Bash command whatever its type: an array shows its first element, any other non-string value shows nothing. */
const commandTextOf = (toolInput: unknown): string | undefined => {
  if (typeof toolInput === 'string') return toolInput;
  if (!isRecord(toolInput) || !('command' in toolInput)) return undefined;
  const command = toolInput.command;
  if (typeof command === 'string') return command;
  const firstElement = Array.isArray(command) ? command[0] : undefined;
  return typeof firstElement === 'string' ? firstElement : '';
};

const capped = (text: string): string =>
  text.length > PENDING_PERMISSION_INPUT_LIMIT ? `${text.slice(0, PENDING_PERMISSION_INPUT_LIMIT)}${PENDING_PERMISSION_TRUNCATION_MARKER}` : text;

/** The first word of the command, the file path, or the compact form of the tool input, on one line. */
const readableInputOf = (toolInput: unknown): string => {
  const command = commandTextOf(toolInput);
  if (command !== undefined) return firstWordOf(command);
  const filePath = stringFieldOf(toolInput, FILE_TOOLS_PATH_FIELDS);
  return oneLine(filePath ?? compactFormOf(toolInput));
};

/** The input is masked before it is capped, so a secret cut by the limit never leaves its head readable. */
export const pendingPermissionViewOf = (approval: Approval, now: Date): PendingPermissionView => ({
  toolName: approval.toolName,
  ageSeconds: Math.floor((now.getTime() - new Date(approval.createdAt).getTime()) / 1000),
  input: capped(maskedSecrets(readableInputOf(approval.toolInput))),
});
