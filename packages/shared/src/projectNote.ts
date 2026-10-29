export const MAX_PROJECT_NOTE_LINE_CHARS = 300;

const REDACTED = '[redacted]';
const SECRET_WORDS = '(?:secret|token|password|passwd|api[_-]?key)';
const SECRET_NAME = `[A-Za-z0-9_]*${SECRET_WORDS}[A-Za-z0-9_]*`;
const QUOTED_VALUE = `"[^"]*"|'[^']*'`;

/** `name = "quoted value"`, `"name": "quoted value"`: the whole quoted value is masked. */
const SECRET_QUOTED_ASSIGNMENT = new RegExp(`(["']?\\b${SECRET_NAME}["']?\\s*[=:]\\s*)(?:${QUOTED_VALUE})`, 'gi');
/** `name = several words` (spaces around the separator): the value runs to the end of the line. */
const SECRET_SPACED_ASSIGNMENT = new RegExp(`(\\b${SECRET_NAME}\\s+[=:]\\s+|\\b${SECRET_NAME}\\s*[=:]\\s+)[^\\n]+`, 'gi');
/** `name=value`, `name: value`: the value is the next word. */
const SECRET_WORD_ASSIGNMENT = new RegExp(`(\\b${SECRET_NAME}\\s*[=:]\\s*)\\S+`, 'gi');
const SPOKEN_PASSWORD = /\b(password|passwd)\s+is\s+\S+/gi;
const BEARER_CREDENTIAL = /\bBearer\s+[^\s"']+/gi;
const URL_CREDENTIALS = /(:\/\/)[^\s/:@]+:[^\s/@]+@/g;
const WELL_KNOWN_KEYS = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g;
// The shared package cannot import packages/core, so these formats duplicate WELL_KNOWN_CREDENTIAL and AUTHORIZED_BASIC_CREDENTIAL of packages/core/src/redact.ts: change both together.
const WELL_KNOWN_FORMATS = new RegExp(
  [
    '\\bgithub_pat_[A-Za-z0-9_]{50,}',
    '\\bglpat-[A-Za-z0-9_-]{20,}(?:\\.01\\.[A-Za-z0-9]{4,})?',
    '\\b(?:xoxe\\.)?xox[abcdeprs]-[A-Za-z0-9%-]{10,}',
    '(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\\.eyJ[A-Za-z0-9_-]{5,}(?:\\.[A-Za-z0-9_-]*)?',
    '\\bnpm_[A-Za-z0-9]{36}',
  ].join('|'),
  'g',
);
const AUTHORIZATION_CREDENTIAL = /\b((?:Proxy-)?Authorization\s*[:=]\s*)(?:Basic|token)\s+[^\s"']+/gi;
const TEMPLATE_BRACES = /[{}]{2,}/g;
const COMMAND_NAMES = ['install', 'build', 'test', 'dev'] as const;

export type ProjectCommandName = (typeof COMMAND_NAMES)[number];

export interface ProjectNoteInput {
  name: string;
  goal?: string;
  repositories?: readonly string[];
  stack?: readonly string[];
  commands?: Partial<Record<ProjectCommandName, string>>;
}

/** The note title for a project name, neutralised the same way as the note body. */
export function projectNoteTitle(name: string): string {
  return `Project: ${oneSafeLine(name)}`;
}

/** Whether a project name keeps any text once neutralised for the note title. */
export function hasNoteTitleText(name: string): boolean {
  return oneSafeLine(name) !== '';
}

/** Builds the markdown body of the "Project: <name>" note; every user text is one capped line without template braces or secrets. */
export function renderProjectNote({ name, goal, repositories = [], stack = [], commands = {} }: ProjectNoteInput): string {
  const goalLine = goal === undefined ? '' : oneSafeLine(goal);
  const commandBullets = COMMAND_NAMES.flatMap((commandName) => {
    const command = oneSafeLine(commands[commandName] ?? '');
    return command === '' ? [] : [`- ${commandName}: \`${command.replaceAll('`', "'")}\``];
  });
  const sections = [
    section('Goal', goalLine === '' ? [] : [goalLine]),
    section('Repositories', bullets(repositories)),
    section('Stack', bullets(stack)),
    section('Commands', commandBullets),
  ].filter((lines) => lines.length > 0);
  return [`# ${projectNoteTitle(name)}`, '', ...sections.flatMap((lines) => [...lines, '']), ''].join('\n').replace(/\n\n$/, '\n');
}

function section(heading: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : [`## ${heading}`, ...lines];
}

function bullets(items: readonly string[]): string[] {
  return items.map(oneSafeLine).filter((item) => item !== '').map((item) => `- ${item}`);
}

function withoutSecrets(text: string): string {
  return text
    .replace(SECRET_QUOTED_ASSIGNMENT, `$1${REDACTED}`)
    .replace(SECRET_SPACED_ASSIGNMENT, `$1${REDACTED}`)
    .replace(SECRET_WORD_ASSIGNMENT, `$1${REDACTED}`)
    .replace(SPOKEN_PASSWORD, `$1 is ${REDACTED}`)
    .replace(BEARER_CREDENTIAL, `Bearer ${REDACTED}`)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(AUTHORIZATION_CREDENTIAL, `$1${REDACTED}`)
    .replace(WELL_KNOWN_KEYS, REDACTED)
    .replace(WELL_KNOWN_FORMATS, REDACTED);
}

function oneSafeLine(text: string): string {
  return withoutSecrets(text)
    .replace(TEMPLATE_BRACES, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PROJECT_NOTE_LINE_CHARS);
}
