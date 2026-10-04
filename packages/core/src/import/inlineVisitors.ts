import { MENTION_KINDS, type MentionKind } from '@openfleet/shared';
import { numberField, stringField, type LexicalNode, type NodeVisitor } from './lexicalNode.js';
import { delimiterLongerThanAnyBacktickRunIn } from './markdownFences.js';

export const HARD_BREAK = '  \n';
const EMPTY_PART = '—';
const MENTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const FORMAT_BOLD = 1;
const FORMAT_ITALIC = 2;
const FORMAT_STRIKETHROUGH = 4;
const FORMAT_CODE = 16;
const KNOWN_FORMAT_MASK = FORMAT_BOLD | FORMAT_ITALIC | FORMAT_STRIKETHROUGH | FORMAT_CODE;

const wrapInlineCode = (code: string): string => {
  const delimiter = delimiterLongerThanAnyBacktickRunIn(code, { minimumLength: 1 });
  const touchesBacktick = code.startsWith('`') || code.endsWith('`');
  const padding = touchesBacktick ? ' ' : '';
  return `${delimiter}${padding}${code}${padding}${delimiter}`;
};

const wrapWith = (marker: string) => (value: string) => `${marker}${value}${marker}`;

const TEXT_FORMAT_WRAPPERS = [
  { bit: FORMAT_CODE, wrap: wrapInlineCode },
  { bit: FORMAT_BOLD, wrap: wrapWith('**') },
  { bit: FORMAT_ITALIC, wrap: wrapWith('*') },
  { bit: FORMAT_STRIKETHROUGH, wrap: wrapWith('~~') },
] as const;

const OPENFLEET_KIND_BY_SCAPE_KIND: Record<string, MentionKind> = {
  note: 'note',
  dataStore: 'table',
  playbook: 'playbook',
  repo: 'repo',
};

const wrapKeepingOuterWhitespace = (value: string, wrap: (core: string) => string): string => {
  const [, leading = '', core = '', trailing = ''] = /^(\s*)(.*?)(\s*)$/s.exec(value) ?? [];
  const hasNothingToWrap = core === '';
  if (hasNothingToWrap) return value;
  return `${leading}${wrap(core)}${trailing}`;
};

export const visitText: NodeVisitor = (node, context) => {
  const format = numberField(node, 'format', 0);
  const activeWrappers = TEXT_FORMAT_WRAPPERS.filter(({ bit }) => (format & bit) !== 0);
  const formattedText = activeWrappers.reduce(
    (wrapped, { wrap }) => wrapKeepingOuterWhitespace(wrapped, wrap),
    stringField(node, 'text'),
  );

  const unknownFormatBits = format & ~KNOWN_FORMAT_MASK;
  const hasUnknownFormat = unknownFormatBits !== 0;
  if (!hasUnknownFormat) return formattedText;
  return formattedText + context.renderUnconverted(`text-format:${unknownFormatBits}`);
};

export const visitLinebreak: NodeVisitor = () => HARD_BREAK;

const mentionedIdOf = (node: LexicalNode, scapeKind: string): string => {
  const genericId = stringField(node, 'mentionId');
  if (scapeKind !== 'note') return genericId;
  return stringField(node, 'mentionNoteID') || genericId;
};

export const visitMention: NodeVisitor = (node, context) => {
  const scapeKind = stringField(node, 'mentionKind');
  const openFleetKind = Object.hasOwn(OPENFLEET_KIND_BY_SCAPE_KIND, scapeKind) ? OPENFLEET_KIND_BY_SCAPE_KIND[scapeKind] : undefined;
  const isSupportedKind = openFleetKind !== undefined && MENTION_KINDS.includes(openFleetKind);
  if (!isSupportedKind) return context.renderUnconverted(`mention:${scapeKind}`);

  const mentionedId = mentionedIdOf(node, scapeKind);
  const idFitsMentionSyntax = MENTION_ID_PATTERN.test(mentionedId);
  if (!idFitsMentionSyntax) return context.renderUnconverted(`mention:${scapeKind}`);

  return `@${openFleetKind}:${mentionedId}`;
};

export const visitMissionLawBound: NodeVisitor = (node) => {
  const parts = ['scope', 'condition', 'exclusions'].map((field) => stringField(node, field));
  const isEmptyBound = parts.every((part) => part === '');
  if (isEmptyBound) return '';

  const readableParts = parts.map((part) => part || EMPTY_PART);
  return `${HARD_BREAK}Permission: ${readableParts.join(' / ')}`;
};
