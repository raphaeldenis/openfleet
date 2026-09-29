import { MENTION_KINDS, type MentionKind, type MentionRef } from '@openfleet/shared';

const DEFAULT_DEPTH = 2;
const DEFAULT_BUDGET_BYTES = 64 * 1024;
const MAX_SKIP_LINES = 50;
const BLOCK_SEPARATOR = '\n\n';
const MENTION_PATTERN = new RegExp(`(?<![A-Za-z0-9_])@(${MENTION_KINDS.join('|')}):([A-Za-z0-9_-]+)`, 'g');

type OtherMentionKind = Exclude<MentionKind, 'note'>;
type MentionedNote = NonNullable<ReturnType<MentionLookup['getNote']>>;

/**
 * Resolves the items a note body mentions.
 * Each method returns undefined for an id that does not exist or that the caller may not read,
 * and throws only on an infrastructure failure, which propagates out of `expandMentions`.
 */
export interface MentionLookup {
  getNote(id: string): { id: string; title: string; bodyMd: string; projectId: string } | undefined;
  describeOther(kind: OtherMentionKind, id: string): { name: string; toolHint: string } | undefined;
}

export interface ExpandMentionsOptions {
  depth?: number;
  budgetBytes?: number;
  rootNoteId?: string;
}

interface BodyToScan {
  bodyMd: string;
  level: number;
}

interface Walk {
  lookup: MentionLookup;
  maxDepth: number;
  expandedNoteIds: Set<string>;
  bodiesToScan: BodyToScan[];
  bytesLeft: number;
  isBudgetExhausted: boolean;
  skipLineCount: number;
}

/**
 * Returns the body followed by one block per @-mention, walking breadth-first so that every note
 * expands at its shortest distance from the body, up to `depth` levels, once each.
 * Content blocks share `budgetBytes` (UTF-8): from the first block that does not fit, every remaining
 * mention is listed as "not expanded (budget)". Skip lines are free of the budget and capped
 * at 50, the others being counted in a single closing line.
 * A mention the lookup cannot resolve renders as "not resolved".
 */
export function expandMentions(bodyMd: string, lookup: MentionLookup, opts: ExpandMentionsOptions = {}): string {
  const { depth = DEFAULT_DEPTH, budgetBytes = DEFAULT_BUDGET_BYTES, rootNoteId } = opts;
  const walk: Walk = {
    lookup,
    maxDepth: depth,
    expandedNoteIds: new Set(rootNoteId === undefined ? [] : [rootNoteId]),
    bodiesToScan: [{ bodyMd, level: 1 }],
    bytesLeft: budgetBytes - utf8Bytes(bodyMd),
    isBudgetExhausted: false,
    skipLineCount: 0,
  };
  const blocks = [bodyMd];

  for (const bodyToScan of walk.bodiesToScan) {
    for (const mention of findMentions(bodyToScan.bodyMd)) {
      const block = renderMention(mention, bodyToScan.level, walk);
      if (block !== undefined) blocks.push(block);
    }
  }

  const unrenderedSkipLineCount = walk.skipLineCount - MAX_SKIP_LINES;
  if (unrenderedSkipLineCount > 0) blocks.push(moreSkippedLine(unrenderedSkipLineCount));

  return blocks.join(BLOCK_SEPARATOR);
}

function renderMention(mention: MentionRef, level: number, walk: Walk): string | undefined {
  const tag = mentionTag(mention.kind, mention.id);

  if (walk.isBudgetExhausted) return skipLine(walk, notExpandedLine(tag, 'budget'));

  const isBeyondDepthLimit = level > walk.maxDepth;
  if (isBeyondDepthLimit) return skipLine(walk, notExpandedLine(tag, 'depth'));

  if (mention.kind === 'note') return renderNoteBlock(mention.id, level, walk);
  return renderPointer(mention.kind, mention.id, walk);
}

function renderNoteBlock(id: string, level: number, walk: Walk): string | undefined {
  const tag = mentionTag('note', id);

  if (walk.expandedNoteIds.has(id)) return skipLine(walk, notExpandedLine(tag, 'already expanded'));

  const note = walk.lookup.getNote(id);
  if (!note) return skipLine(walk, notResolvedLine(tag));

  const noteBlock = noteBlockOf(tag, note);
  if (!reserveBudget(walk, noteBlock)) return skipLine(walk, notExpandedLine(tag, 'budget'));

  walk.expandedNoteIds.add(note.id);
  walk.bodiesToScan.push({ bodyMd: note.bodyMd, level: level + 1 });
  return noteBlock;
}

function renderPointer(kind: OtherMentionKind, id: string, walk: Walk): string | undefined {
  const tag = mentionTag(kind, id);

  const item = walk.lookup.describeOther(kind, id);
  if (!item) return skipLine(walk, notResolvedLine(tag));

  const pointer = `--- ${tag} → ${kind} "${singleLine(item.name)}" — ${singleLine(item.toolHint)} ---`;
  if (!reserveBudget(walk, pointer)) return skipLine(walk, notExpandedLine(tag, 'budget'));

  return pointer;
}

function reserveBudget(walk: Walk, block: string): boolean {
  const blockBytes = utf8Bytes(BLOCK_SEPARATOR + block);
  const blockFits = blockBytes <= walk.bytesLeft;
  if (!blockFits) {
    walk.isBudgetExhausted = true;
    return false;
  }
  walk.bytesLeft -= blockBytes;
  return true;
}

function skipLine(walk: Walk, line: string): string | undefined {
  walk.skipLineCount += 1;
  const isWithinCap = walk.skipLineCount <= MAX_SKIP_LINES;
  return isWithinCap ? line : undefined;
}

function findMentions(bodyMd: string): MentionRef[] {
  const mentions = [...bodyMd.matchAll(MENTION_PATTERN)].map(([, kind, id]) => ({ kind, id }) as MentionRef);
  const firstOfEachTag = new Map(mentions.map((mention) => [mentionTag(mention.kind, mention.id), mention]));
  return [...firstOfEachTag.values()];
}

const noteBlockOf = (tag: string, note: MentionedNote) =>
  `--- from note ${tag} (${singleLine(note.title)}, ${singleLine(note.projectId)}) ---\n${note.bodyMd}\n--- end ${tag} ---`;

const mentionTag = (kind: MentionKind, id: string) => `@${kind}:${id}`;

const notResolvedLine = (tag: string) => `--- ${tag} → not resolved (not available yet) ---`;

const notExpandedLine = (tag: string, reason: string) => `--- ${tag}: not expanded (${reason}) ---`;

const moreSkippedLine = (count: number) => `--- and ${count} more mentions not expanded ---`;

const singleLine = (text: string) => text.replace(/[\r\n]/g, ' ');

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');
