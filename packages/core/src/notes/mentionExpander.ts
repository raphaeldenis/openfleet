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
}

/**
 * Returns the body followed by one block per @-mention, walking notes up to `depth` levels,
 * expanding each note once, and stopping before the first block that would exceed `budgetBytes` (UTF-8).
 * A mention the lookup cannot resolve renders as "not resolved", whatever the reason.
 */
export function expandMentions(bodyMd: string, lookup: MentionLookup, opts: ExpandMentionsOptions = {}): string {
  const { depth = DEFAULT_DEPTH, budgetBytes = DEFAULT_BUDGET_BYTES, rootNoteId } = opts;
  const expandedNoteIds = new Set(rootNoteId === undefined ? [] : [rootNoteId]);
  const walk: Walk = { lookup, maxDepth: depth, expandedNoteIds };

  const output = [bodyMd];
  let bytesUsed = utf8Bytes(bodyMd);
  for (const block of renderMentions(bodyMd, 1, walk)) {
    const bytesWithBlock = bytesUsed + utf8Bytes(BLOCK_SEPARATOR + block);
    const blockExceedsBudget = bytesWithBlock > budgetBytes;
    if (blockExceedsBudget) break;
    output.push(block);
    bytesUsed = bytesWithBlock;
  }
  return output.join(BLOCK_SEPARATOR);
}

function* renderMentions(bodyMd: string, level: number, walk: Walk): Generator<string> {
  for (const mention of findMentions(bodyMd)) {
    const tag = `@${mention.kind}:${mention.id}`;

    const isBeyondDepthLimit = level > walk.maxDepth;
    if (isBeyondDepthLimit) {
      yield notExpandedLine(tag, 'depth');
      continue;
    }

    if (mention.kind !== 'note') {
      yield renderOtherMention(mention.kind, mention.id, walk.lookup);
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

    walk.expandedNoteIds.add(note.id);
    yield `--- from note ${tag} (${note.title}, ${note.projectId}) ---\n${note.bodyMd}\n--- end ${tag} ---`;
    yield* renderMentions(note.bodyMd, level + 1, walk);
  }
}

function renderOtherMention(kind: OtherMentionKind, id: string, lookup: MentionLookup): string {
  const tag = `@${kind}:${id}`;
  const item = lookup.describeOther(kind, id);
  if (!item) return notResolvedLine(tag);
  return `--- ${tag} → ${kind} "${item.name}" — ${item.toolHint} ---`;
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
