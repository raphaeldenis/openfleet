import { visitCode, visitHeading, visitList, visitParagraph, visitQuote, visitTable } from './blockVisitors.js';
import { joinInlinePieces } from './inlineJoin.js';
import { visitLinebreak, visitMention, visitMissionLawBound, visitText } from './inlineVisitors.js';
import { BLOCK_SEPARATOR, childrenOf, type LexicalNode, type NodeVisitor, type RenderContext } from './lexicalNode.js';
import {
  visitMissionBody,
  visitMissionLaws,
  visitMissionProfile,
  visitMissionPulseActions,
  visitMissionResources,
} from './missionVisitors.js';

export interface LexicalConversion {
  markdown: string;
  unconvertedTypes: string[];
}

const VISITOR_BY_NODE_TYPE: Record<string, NodeVisitor> = {
  paragraph: visitParagraph,
  heading: visitHeading,
  quote: visitQuote,
  code: visitCode,
  list: visitList,
  table: visitTable,
  text: visitText,
  linebreak: visitLinebreak,
  mention: visitMention,
  'mission-profile': visitMissionProfile,
  'mission-body': visitMissionBody,
  'mission-pulse-actions': visitMissionPulseActions,
  'mission-laws': visitMissionLaws,
  'mission-law-bound': visitMissionLawBound,
  'mission-resources': visitMissionResources,
};

const INLINE_NODE_TYPES = new Set(['text', 'linebreak', 'mention', 'mission-law-bound']);
const LEADING_LINE_BREAK = /^(?: {2})?\n+/;

const parseRoot = (input: string | object): LexicalNode => {
  const document = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
  const root = (document as { root?: Partial<LexicalNode> } | null)?.root;
  const isRootNode = root?.type === 'root' && Array.isArray(root.children);
  if (!isRootNode) throw new Error('Lexical document has no root node with a children array');
  return root as LexicalNode;
};

/** Converts a Scape lexical document (JSON string or parsed object) to OpenFleet markdown. */
export function convertLexicalToMarkdown(input: string | object): LexicalConversion {
  const unconvertedTypes = new Set<string>();

  const renderUnconverted = (typeLabel: string): string => {
    unconvertedTypes.add(typeLabel);
    return `[non converti: ${typeLabel}]`;
  };

  const renderUnknownNode = (node: LexicalNode): string => {
    const marker = renderUnconverted(node.type);
    const children = childrenOf(node);
    const hasChildren = children.length > 0;
    if (!hasChildren) return marker;

    const hasOnlyInlineChildren = children.every((child) => INLINE_NODE_TYPES.has(child.type));
    if (hasOnlyInlineChildren) return marker + context.renderInline(children);
    return marker + BLOCK_SEPARATOR + context.renderBlocks(children);
  };

  const renderNode = (node: LexicalNode): string => {
    const isKnownType = Object.hasOwn(VISITOR_BY_NODE_TYPE, node.type);
    if (!isKnownType) return renderUnknownNode(node);
    const visitor = VISITOR_BY_NODE_TYPE[node.type] as NodeVisitor;
    return visitor(node, context);
  };

  const context: RenderContext = {
    renderBlocks: (nodes) => nodes.map(renderNode).filter((block) => block !== '').join(BLOCK_SEPARATOR),
    renderInline: (nodes) => {
      const pieces = nodes.map((node) => ({ markdown: renderNode(node), isMentionReference: node.type === 'mention' }));
      return joinInlinePieces(pieces).replace(LEADING_LINE_BREAK, '');
    },
    renderUnconverted,
  };

  const markdown = context.renderBlocks(childrenOf(parseRoot(input)));
  return { markdown, unconvertedTypes: [...unconvertedTypes] };
}
