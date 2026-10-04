import { childrenOf, numberField, stringField, type LexicalNode, type NodeVisitor, type RenderContext } from './lexicalNode.js';

import { delimiterLongerThanAnyBacktickRunIn } from './markdownFences.js';
import { wrapInlineCode } from './inlineVisitors.js';

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
  const headingText = context.renderInline(childrenOf(node)).replace(/[ \t]*[\r\n]+[ \t]*/g, ' ');
  return `${'#'.repeat(level)} ${headingText}`;
};

export const visitQuote: NodeVisitor = (node, context) => prefixEveryLine(context.renderInline(childrenOf(node)), '> ');

const codeTextOf = (node: LexicalNode): string => childrenOf(node)
    .map((child) => (child.type === 'linebreak' ? '\n' : stringField(child, 'text')))
    .join('');

export const visitCode: NodeVisitor = (node) => {
  const codeText = codeTextOf(node);
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
    const hasOnlyNestedLists = isOnlyNestedLists(item);
    const hasParentItem = lastMarkerWidth > 0;
    if (hasOnlyNestedLists && hasParentItem) {
      outputLines.push(...indentContinuationLines(renderListItemLines(item, context), lastMarkerWidth));
      continue;
    }
    const marker = isNumbered ? `${itemNumber}. ` : '- ';
    itemNumber += 1;
    lastMarkerWidth = marker.length;
    if (hasOnlyNestedLists) {
      outputLines.push(marker, ...indentContinuationLines(renderListItemLines(item, context), marker.length));
      continue;
    }
    const [firstLine = '', ...continuationLines] = renderListItemLines(item, context);
    outputLines.push(marker + firstLine, ...indentContinuationLines(continuationLines, marker.length));
  }

  return outputLines.join('\n');
};

const renderCellBlock = (node: LexicalNode, context: RenderContext): string => {
  if (node.type === 'heading') return context.renderInline(childrenOf(node));
  if (node.type === 'code') return codeTextOf(node).split('\n').map(wrapInlineCode).join(TABLE_CELL_LINE_BREAK);
  return context.renderBlocks([node]);
};

const escapeTablePipes = (markdown: string): string => markdown.replace(/(\\*)\|/g, (pipeWithBackslashes: string, backslashes: string) => {
  const isAlreadyEscaped = backslashes.length % 2 === 1;
  return isAlreadyEscaped ? pipeWithBackslashes : `${backslashes}\\|`;
});

const renderTableCell = (cell: LexicalNode, context: RenderContext): string => {
  const cellMarkdown = childrenOf(cell).map((node) => renderCellBlock(node, context)).filter((block) => block !== '').join('\n\n');
  const singleLineCell = cellMarkdown.replace(/\s*\n+/g, TABLE_CELL_LINE_BREAK);
  return escapeTablePipes(singleLineCell);
};

export const visitTable: NodeVisitor = (node, context) => {
  const rows = childrenOf(node).map((row) => childrenOf(row).map((cell) => renderTableCell(cell, context)));
  const [headerRow, ...bodyRows] = rows;
  if (headerRow === undefined) return '';
  const columnCount = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (columnCount === 0) return '';

  const toMarkdownRow = (cells: string[]) => {
    const paddedCells = Array.from({ length: columnCount }, (_, index) => cells[index] ?? '');
    return `| ${paddedCells.join(' | ')} |`;
  };
  const separatorRow = toMarkdownRow(Array<string>(columnCount).fill('---'));
  return [toMarkdownRow(headerRow), separatorRow, ...bodyRows.map(toMarkdownRow)].join('\n');
};
