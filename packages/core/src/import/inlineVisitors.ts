import { MENTION_KINDS, type MentionKind } from '@openfleet/shared';
import { numberField, stringField, type NodeVisitor } from './lexicalNode.js';

const HARD_BREAK = '  \n';
const EMPTY_PART = '—';
const MENTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const TEXT_FORMAT_MARKERS = [
  { bit: 16, marker: '`' },
  { bit: 1, marker: '**' },
  { bit: 2, marker: '*' },
  { bit: 4, marker: '~~' },
] as const;

const OPENFLEET_KIND_BY_SCAPE_KIND: Record<string, MentionKind> = {
  note: 'note',
  dataStore: 'table',
  playbook: 'playbook',
  repo: 'repo',
};

const wrapKeepingOuterWhitespace = (value: string, marker: string): string => {
  const [, leading = '', core = '', trailing = ''] = /^(\s*)(.*?)(\s*)$/s.exec(value) ?? [];
  const hasNothingToWrap = core === '';
  if (hasNothingToWrap) return value;
  return `${leading}${marker}${core}${marker}${trailing}`;
};

export const visitText: NodeVisitor = (node) => {
  const format = numberField(node, 'format', 0);
  const activeMarkers = TEXT_FORMAT_MARKERS.filter(({ bit }) => (format & bit) !== 0);
  return activeMarkers.reduce((wrapped, { marker }) => wrapKeepingOuterWhitespace(wrapped, marker), stringField(node, 'text'));
};

export const visitLinebreak: NodeVisitor = () => HARD_BREAK;

export const visitMention: NodeVisitor = (node, context) => {
  const scapeKind = stringField(node, 'mentionKind');
  const openFleetKind = OPENFLEET_KIND_BY_SCAPE_KIND[scapeKind];
  const isSupportedKind = openFleetKind !== undefined && MENTION_KINDS.includes(openFleetKind);
  if (!isSupportedKind) return context.renderUnconverted(`mention:${scapeKind}`);

  const mentionedId = stringField(node, scapeKind === 'note' ? 'mentionNoteID' : 'mentionId') || stringField(node, 'mentionId');
  const idFitsMentionSyntax = MENTION_ID_PATTERN.test(mentionedId);
  if (!idFitsMentionSyntax) return context.renderUnconverted(`mention:${scapeKind}`);

  return `@${openFleetKind}:${mentionedId}`;
};

export const visitMissionLawBound: NodeVisitor = (node) => {
  const parts = ['scope', 'condition', 'exclusions'].map((field) => stringField(node, field) || EMPTY_PART);
  return `\nPermission: ${parts.join(' / ')}`;
};
