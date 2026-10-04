export interface LexicalNode {
  type: string;
  children?: LexicalNode[];
  [field: string]: unknown;
}

export interface RenderContext {
  renderBlocks(nodes: LexicalNode[]): string;
  renderInline(nodes: LexicalNode[]): string;
  renderUnconverted(typeLabel: string): string;
}

export type NodeVisitor = (node: LexicalNode, context: RenderContext) => string;

export const BLOCK_SEPARATOR = '\n\n';

export const childrenOf = (node: LexicalNode): LexicalNode[] => node.children ?? [];

export const stringField = (node: LexicalNode, field: string): string => {
  const value = node[field];
  return typeof value === 'string' ? value : '';
};

export const numberField = (node: LexicalNode, field: string, fallback: number): number => {
  const value = node[field];
  return typeof value === 'number' ? value : fallback;
};
