import { visitCode, visitHeading, visitList, visitParagraph, visitQuote, visitTable } from './blockVisitors.js';
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

const parseDocument = (input: string | object): LexicalNode => {
  const document = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
  const root = (document as { root?: LexicalNode }).root;
  if (root === undefined) throw new Error('Lexical document has no root node');
  return root;
};

/** Converts a Scape lexical document (JSON string or parsed object) to OpenFleet markdown. */
export function convertLexicalToMarkdown(input: string | object): LexicalConversion {
  const unconvertedTypes = new Set<string>();

  const renderUnconverted = (typeLabel: string): string => {
    unconvertedTypes.add(typeLabel);
    return `[non converti: ${typeLabel}]`;
  };

  const renderNode = (node: LexicalNode): string => {
    const visitor = VISITOR_BY_NODE_TYPE[node.type];
    return visitor === undefined ? renderUnconverted(node.type) : visitor(node, context);
  };

  const context: RenderContext = {
    renderBlocks: (nodes) => nodes.map(renderNode).filter((block) => block !== '').join(BLOCK_SEPARATOR),
    renderInline: (nodes) => nodes.map(renderNode).join('').replace(/^\n+/, ''),
    renderUnconverted,
  };

  const markdown = context.renderBlocks(childrenOf(parseDocument(input)));
  return { markdown, unconvertedTypes: [...unconvertedTypes] };
}
