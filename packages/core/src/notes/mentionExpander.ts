import { MENTION_KINDS, MentionRefSchema, type MentionKind, type MentionRef } from '@openfleet/shared';

const DEFAULT_DEPTH = 2;
const DEFAULT_BUDGET_BYTES = 64 * 1024;
const BLOCK_SEPARATOR = '\n\n';
const MENTION_PATTERN = new RegExp(`@(${MENTION_KINDS.join('|')}):([A-Za-z0-9_-]+)`, 'g');

type OtherMentionKind = Exclude<MentionKind, 'note'>;

export interface MentionLookup {
  getNote(id: string): { id: string; title: string; bodyMd: string; projectId: string } | undefined;
  describeOther(kind: OtherMentionKind, id: string): { name: string; toolHint: string } | undefined;
}

export interface ExpandMentionsOptions {
  depth?: number;
  budgetBytes?: number;
  rootNoteId?: string;
}

interface Walk {
  lookup: MentionLookup;
  maxDepth: number;
  expandedNoteIds: Set<string>;
  bytesLeft: number;
  isBudgetExhausted: boolean;
}

/**
 * Returns the body followed by one block per @-mention, walking notes up to `depth` levels
 * and expanding each note once. Content blocks share `budgetBytes` (UTF-8): from the first block
 * that does not fit, every remaining mention is listed as "not expanded (budget)".
 * Skip lines are free of the budget. A mention the lookup cannot resolve renders as "not resolved".
 */
export function expandMentions(bodyMd: string, lookup: MentionLookup, opts: ExpandMentionsOptions = {}): string {
  const { depth = DEFAULT_DEPTH, budgetBytes = DEFAULT_BUDGET_BYTES, rootNoteId } = opts;
  const walk: Walk = {
    lookup,
    maxDepth: depth,
    expandedNoteIds: new Set(rootNoteId === undefined ? [] : [rootNoteId]),
    bytesLeft: budgetBytes - utf8Bytes(bodyMd),
    isBudgetExhausted: false,
  };

  return [bodyMd, ...renderMentions(bodyMd, 1, walk)].join(BLOCK_SEPARATOR);
}

function* renderMentions(bodyMd: string, level: number, walk: Walk): Generator<string> {
  for (const mention of findMentions(bodyMd)) {
    const tag = `@${mention.kind}:${mention.id}`;

    if (walk.isBudgetExhausted) {
      yield notExpandedLine(tag, 'budget');
      continue;
    }

    const isBeyondDepthLimit = level > walk.maxDepth;
    if (isBeyondDepthLimit) {
      yield notExpandedLine(tag, 'depth');
      continue;
    }

    if (mention.kind !== 'note') {
      const item = walk.lookup.describeOther(mention.kind, mention.id);
      if (!item) {
        yield notResolvedLine(tag);
        continue;
      }
      const pointer = `--- ${tag} → ${mention.kind} "${item.name}" — ${item.toolHint} ---`;
      yield takeFromBudget(walk, pointer) ? pointer : notExpandedLine(tag, 'budget');
      continue;
    }

    if (walk.expandedNoteIds.has(mention.id)) {
      yield notExpandedLine(tag, 'already expanded');
      continue;
    }

    const note = walk.lookup.getNote(mention.id);
    if (!note) {
      yield notResolvedLine(tag);
      continue;
    }

    const noteBlock = `--- from note ${tag} (${note.title}, ${note.projectId}) ---\n${note.bodyMd}\n--- end ${tag} ---`;
    if (!takeFromBudget(walk, noteBlock)) {
      yield notExpandedLine(tag, 'budget');
      continue;
    }

    walk.expandedNoteIds.add(note.id);
    yield noteBlock;
    yield* renderMentions(note.bodyMd, level + 1, walk);
  }
}

function takeFromBudget(walk: Walk, block: string): boolean {
  const blockBytes = utf8Bytes(BLOCK_SEPARATOR + block);
  const blockFits = blockBytes <= walk.bytesLeft;
  if (!blockFits) {
    walk.isBudgetExhausted = true;
    return false;
  }
  walk.bytesLeft -= blockBytes;
  return true;
}

function findMentions(bodyMd: string): MentionRef[] {
  const mentions = [...bodyMd.matchAll(MENTION_PATTERN)].map(([, kind, id]) =>
    MentionRefSchema.parse({ kind, id }),
  );
  const firstOfEachTag = new Map(mentions.map((mention) => [`${mention.kind}:${mention.id}`, mention]));
  return [...firstOfEachTag.values()];
}

const notResolvedLine = (tag: string) => `--- ${tag} → not resolved (not available yet) ---`;

const notExpandedLine = (tag: string, reason: string) => `--- ${tag}: not expanded (${reason}) ---`;

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');
