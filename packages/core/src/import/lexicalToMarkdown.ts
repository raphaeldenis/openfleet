import { visitCode, visitHeading, visitHorizontalRule, visitList, visitParagraph, visitQuote, visitTable } from './blockVisitors.js';
import { joinInlinePieces } from './inlineJoin.js';
import { visitLinebreak, visitLink, visitMention, visitMissionLawBound, visitTab, visitText } from './inlineVisitors.js';
import { BLOCK_SEPARATOR, childrenOf, stringField, type LexicalNode, type NodeVisitor, type RenderContext } from './lexicalNode.js';
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
  horizontalrule: visitHorizontalRule,
  text: visitText,
  tab: visitTab,
  link: visitLink,
  autolink: visitLink,
  linebreak: visitLinebreak,
  mention: visitMention,
  'mission-profile': visitMissionProfile,
  'mission-body': visitMissionBody,
  'mission-pulse-actions': visitMissionPulseActions,
  'mission-laws': visitMissionLaws,
  'mission-law-bound': visitMissionLawBound,
  'mission-resources': visitMissionResources,
};

const INLINE_NODE_TYPES = new Set(['text', 'tab', 'link', 'autolink', 'linebreak', 'mention', 'mission-law-bound']);
const LEADING_LINE_BREAK = /^(?: {2})?\n+/;
const MAX_NESTING_DEPTH = 100;
const NESTING_TOO_DEEP_LABEL = 'nesting-too-deep';
const NO_TYPE_LABEL = '(sans type)';

/** The type label as it reads inside a marker: one line, its backslashes turned into slashes and its brackets into parentheses so the marker keeps its own brackets paired. */
const markerTextOf = (typeLabel: string): string => typeLabel.replace(/\s+/g, ' ').replace(/\\/g, '/').replace(/\[/g, '(').replace(/\]/g, ')');

const typeLabelOf =(node: LexicalNode): string => {
  const type: unknown = node.type;
  if (typeof type === 'string' && type !== '') return type;
  if (typeof type === 'number' || typeof type === 'boolean') return String(type);
  return NO_TYPE_LABEL;
};

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
    return `[non converti: ${markerTextOf(typeLabel)}]`;
  };

  const renderUnknownNode = (node: LexicalNode): string => {
    const marker = renderUnconverted(typeLabelOf(node));
    const children = childrenOf(node);
    const hasChildren = children.length > 0;
    if (!hasChildren) return marker + stringField(node, 'text');

    const hasOnlyInlineChildren = children.every((child) => INLINE_NODE_TYPES.has(child.type));
    if (hasOnlyInlineChildren) return marker + context.renderInline(children);
    return marker + BLOCK_SEPARATOR + context.renderBlocks(children);
  };

  const renderKnownOrUnknownNode = (node: LexicalNode): string => {
    const isKnownType = typeof node.type === 'string' && Object.hasOwn(VISITOR_BY_NODE_TYPE, node.type);
    if (!isKnownType) return renderUnknownNode(node);
    const visitor = VISITOR_BY_NODE_TYPE[node.type] as NodeVisitor;
    return visitor(node, context);
  };

  let nestingDepth = 0;
  const renderNode = (node: LexicalNode): string => {
    const isTooDeep = nestingDepth >= MAX_NESTING_DEPTH;
    if (isTooDeep) return renderUnconverted(NESTING_TOO_DEEP_LABEL);
    nestingDepth += 1;
    try {
      return renderKnownOrUnknownNode(node);
    } finally {
      nestingDepth -= 1;
    }
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
