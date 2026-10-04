import { childrenOf, numberField, stringField, type LexicalNode, type NodeVisitor, type RenderContext } from './lexicalNode.js';

import { delimiterLongerThanAnyBacktickRunIn } from './markdownFences.js';

const MINIMUM_FENCE_LENGTH = 3;
const DEFAULT_HEADING_LEVEL = 1;
const TABLE_CELL_LINE_BREAK = '<br>';

const isList = (node: LexicalNode) => node.type === 'list';
const isOnlyNestedLists = (item: LexicalNode) => childrenOf(item).length > 0 && childrenOf(item).every(isList);

const indentContinuationLines = (lines: string[], width: number): string[] =>
  lines.map((line) => (line === '' ? line : ' '.repeat(width) + line));

const prefixEveryLine = (value: string, prefix: string): string =>
  value
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');

export const visitParagraph: NodeVisitor = (node, context) => context.renderInline(childrenOf(node));

export const visitHeading: NodeVisitor = (node, context) => {
  const levelDigit = /^h([1-6])$/.exec(stringField(node, 'tag'))?.[1];
  const level = levelDigit === undefined ? DEFAULT_HEADING_LEVEL : Number(levelDigit);
  return `${'#'.repeat(level)} ${context.renderInline(childrenOf(node))}`;
};

export const visitQuote: NodeVisitor = (node, context) => prefixEveryLine(context.renderInline(childrenOf(node)), '> ');

export const visitCode: NodeVisitor = (node) => {
  const codeText = childrenOf(node)
    .map((child) => (child.type === 'linebreak' ? '\n' : stringField(child, 'text')))
    .join('');
  const fence = delimiterLongerThanAnyBacktickRunIn(codeText, { minimumLength: MINIMUM_FENCE_LENGTH });
  return `${fence}${stringField(node, 'language')}\n${codeText}\n${fence}`;
};

const renderListItemLines = (item: LexicalNode, context: RenderContext): string[] => {
  const nestedLists = childrenOf(item).filter(isList);
  const inlineChildren = childrenOf(item).filter((child) => !isList(child));
  const itemText = context.renderInline(inlineChildren);
  const nestedListLines = nestedLists.map((list) => context.renderBlocks([list]));
  const textLines = itemText === '' ? [] : [itemText];
  return [...textLines, ...nestedListLines].join('\n').split('\n');
};

export const visitList: NodeVisitor = (node, context) => {
  const isNumbered = stringField(node, 'listType') === 'number';
  const outputLines: string[] = [];
  let itemNumber = numberField(node, 'start', 1);
  let lastMarkerWidth = 0;

  for (const item of childrenOf(node)) {
    if (isOnlyNestedLists(item)) {
      outputLines.push(...indentContinuationLines(renderListItemLines(item, context), lastMarkerWidth));
      continue;
    }
    const marker = isNumbered ? `${itemNumber}. ` : '- ';
    itemNumber += 1;
    lastMarkerWidth = marker.length;
    const [firstLine = '', ...continuationLines] = renderListItemLines(item, context);
    outputLines.push(marker + firstLine, ...indentContinuationLines(continuationLines, marker.length));
  }

  return outputLines.join('\n');
};

const renderTableCell = (cell: LexicalNode, context: RenderContext): string =>
  context
    .renderBlocks(childrenOf(cell))
    .replace(/\s*\n+/g, TABLE_CELL_LINE_BREAK)
    .replace(/\|/g, '\\|');

export const visitTable: NodeVisitor = (node, context) => {
  const rows = childrenOf(node).map((row) => childrenOf(row).map((cell) => renderTableCell(cell, context)));
  const [headerRow, ...bodyRows] = rows;
  if (headerRow === undefined) return '';

  const toMarkdownRow = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const separatorRow = toMarkdownRow(headerRow.map(() => '---'));
  return [toMarkdownRow(headerRow), separatorRow, ...bodyRows.map(toMarkdownRow)].join('\n');
};
