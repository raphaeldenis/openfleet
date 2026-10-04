import type { Project } from '@openfleet/shared';

const isText = (value: unknown): value is string => typeof value === 'string';

/** Reads a project from a daemon payload, keeping only its known fields; returns undefined when the payload is not a project. */
export function parseProject(payload: unknown): Project | undefined {
  const isObject = typeof payload === 'object' && payload !== null;
  if (!isObject) return undefined;
  const { id, name, docsFolderPath } = payload as Record<string, unknown>;
  if (!isText(id) || id === '' || !isText(name)) return undefined;
  if (docsFolderPath === null || isText(docsFolderPath)) return { id, name, docsFolderPath };
  return undefined;
}
