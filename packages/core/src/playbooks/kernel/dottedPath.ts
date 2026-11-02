/** Reads the member of `root` named by a dotted path (`event.row.x`, `labels.1`); undefined when any step is missing, passes through a scalar, or would read an inherited member. */
export const valueAtDottedPath = (root: unknown, path: string): unknown => {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};
