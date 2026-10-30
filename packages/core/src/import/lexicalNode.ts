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

const UNTYPED_NODE: LexicalNode = Object.freeze({ type: '' });

const isNodeObject = (value: unknown): value is LexicalNode => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns the children as nodes: a child that is not an object stands for a node without type, and a field that is not an array holds no children. */
export const childrenOf = (node: LexicalNode): LexicalNode[] => {
  const children: unknown = node.children;
  if (!Array.isArray(children)) return [];
  return children.map((child) => (isNodeObject(child) ? child : UNTYPED_NODE));
};

export const stringField = (node: LexicalNode, field: string): string => {
  const value = node[field];
  return typeof value === 'string' ? value : '';
};

export const numberField = (node: LexicalNode, field: string, fallback: number): number => {
  const value = node[field];
  return typeof value === 'number' ? value : fallback;
};
